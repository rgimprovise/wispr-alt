/**
 * Streaming transcription proxy.
 *
 * Architecture:
 *   client ────WS────► backend ────WS────► OpenAI Realtime
 *
 * - Audio: client sends raw PCM16 mono 16kHz binary frames; backend
 *   base64-encodes into `input_audio_buffer.append` events.
 * - Control: client sends JSON `{type:"commit"}` when the user releases
 *   the record gesture. Backend forwards `input_audio_buffer.commit` to
 *   OpenAI, awaits `…transcription.completed`, runs cleanup, then sends
 *   the final back as `{type:"final_clean", text}` and closes.
 * - Partials: OpenAI's `…transcription.delta` events are forwarded as
 *   `{type:"partial", text}` to the client for live preview.
 */

import { postprocessText, type Style } from "./transcribe";

export type ClientToServerControl =
  | { type: "commit" }
  | { type: "cancel" };

export type ServerToClientEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final_raw"; text: string }
  | { type: "final_clean"; text: string }
  | { type: "error"; message: string };

const REALTIME_URL =
  "wss://api.openai.com/v1/realtime?intent=transcription";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

interface MinimalWS {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * Per-connection bridge to OpenAI. One instance lives for the duration
 * of a single client WebSocket — created on `onOpen`, torn down on
 * client disconnect or after `final_clean` is sent.
 */
export class StreamSession {
  private upstream: WebSocket | null = null;
  private upstreamReady = false;
  /** Audio frames received before upstream finished handshake — replayed once ready. */
  private audioBacklog: ArrayBuffer[] = [];
  /** Accumulates delta text within the current turn. Reset each completed. */
  private currentTurnDelta = "";
  /** Concatenation of all completed turns so far. */
  private completedTurns = "";
  /** Set when the client has sent `commit` and we're waiting for the last
   *  completed event before running cleanup. */
  private awaitingFinal = false;
  private closed = false;
  /** PCM16 samples appended since the last `input_audio_buffer.commit`.
   *  OpenAI rejects commits with <100 ms of audio (1600 samples @ 16 kHz)
   *  so we gate the autocommit ticker on this. */
  private samplesSinceCommit = 0;
  private commitTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: MinimalWS,
    private readonly style: Style,
    private readonly language: string,
  ) {}

  start(): void {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.sendClient({ type: "error", message: "OPENAI_API_KEY not set" });
      this.close(1011, "missing api key");
      return;
    }

    // Bun's WebSocket constructor takes (url, protocols?, options?). Custom
    // headers go through the `headers` option (non-standard but supported
    // in Bun + Node 22 ws clients).
    this.upstream = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    } as any);

    this.upstream.addEventListener("open", () => this.onUpstreamOpen());
    this.upstream.addEventListener("message", (ev) => this.onUpstreamMessage(ev));
    this.upstream.addEventListener("error", (ev) => this.onUpstreamError(ev));
    this.upstream.addEventListener("close", () => this.onUpstreamClose());
  }

  /** Client → backend audio frame (raw PCM16 LE 16kHz). */
  onAudioFrame(buf: ArrayBuffer): void {
    if (this.closed) return;
    if (!this.upstreamReady) {
      this.audioBacklog.push(buf);
      return;
    }
    this.forwardAudio(buf);
  }

  /** Client → backend control message. */
  onControl(text: string): void {
    if (this.closed) return;
    let msg: ClientToServerControl;
    try {
      msg = JSON.parse(text);
    } catch {
      this.sendClient({ type: "error", message: "invalid control json" });
      return;
    }
    if (msg.type === "commit") {
      // Stop the periodic ticker — the user released the record gesture,
      // we're now flushing any trailing audio and waiting for the last
      // completed event before finalizing.
      this.stopAutoCommit();
      this.awaitingFinal = true;
      // Only send a final commit if there's enough audio; otherwise we'd
      // get input_audio_buffer_commit_empty and the handler bounces us
      // straight to runCleanupAndClose, which is what we want anyway.
      if (this.samplesSinceCommit >= 1600) {
        this.samplesSinceCommit = 0;
        this.sendUpstream({ type: "input_audio_buffer.commit" });
      } else {
        // Nothing left to transcribe — finalize with what we have.
        void this.runCleanupAndClose();
      }
      // Safety net: if neither a `completed` event nor an error arrives
      // within 4s, finalize with what we already have.
      setTimeout(() => {
        if (this.awaitingFinal && !this.closed) {
          void this.runCleanupAndClose();
        }
      }, 4000);
    } else if (msg.type === "cancel") {
      this.close(1000, "cancelled by client");
    }
  }

  /** Called when the client WebSocket closes for any reason. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.upstream?.close(); } catch { /* noop */ }
    this.upstream = null;
  }

  // ─── Upstream lifecycle ────────────────────────────────────────────────

  private onUpstreamOpen(): void {
    this.sendUpstream({
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: {
          model: TRANSCRIBE_MODEL,
          language: this.language,
          prompt:
            "Это запись повседневной русской речи: разговоры, диктовка заметок, " +
            "рабочие сообщения. В тексте могут быть имена собственные, термины " +
            "и отдельные английские слова.",
        },
        // We disable server_vad and commit manually on a fixed cadence
        // (see scheduleAutoCommit). gpt-4o-mini-transcribe only emits
        // deltas after a turn is committed, so VAD-based commits mean
        // a fluent speaker waits ≥1 sentence for the first partial.
        // Time-based commits land short turns (~2-3 words at 600 ms)
        // for sub-second live preview at the cost of occasional
        // mid-word cuts — fine for a preview, the final transcript is
        // a concat of all turns.
        turn_detection: null,
      },
    });
  }

  /**
   * Periodically flushes the input buffer with `input_audio_buffer.commit`
   * so the model produces a `completed` event every ~600 ms instead of
   * waiting for VAD to detect silence. Started after the session is ready.
   */
  private scheduleAutoCommit(): void {
    if (this.commitTimer) return;
    this.commitTimer = setInterval(() => {
      if (this.closed || this.awaitingFinal) return;
      // OpenAI rejects commits with <100 ms (= 1600 samples @ 16 kHz).
      if (this.samplesSinceCommit < 1600) return;
      this.samplesSinceCommit = 0;
      this.sendUpstream({ type: "input_audio_buffer.commit" });
    }, 600);
  }

  private stopAutoCommit(): void {
    if (this.commitTimer) {
      clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private onUpstreamMessage(ev: MessageEvent): void {
    let data: any;
    try {
      data = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
    } catch {
      return;
    }
    switch (data.type) {
      case "transcription_session.updated":
      case "transcription_session.created":
        this.upstreamReady = true;
        this.sendClient({ type: "ready" });
        // Flush backlog of audio frames received during handshake.
        for (const buf of this.audioBacklog) this.forwardAudio(buf);
        this.audioBacklog = [];
        this.scheduleAutoCommit();
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const delta = (data.delta as string) ?? "";
        if (delta) {
          this.currentTurnDelta += delta;
          // Live preview = everything completed so far + the in-progress turn.
          const live = (this.completedTurns + " " + this.currentTurnDelta).trim();
          this.sendClient({ type: "partial", text: live });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const turnText = (data.transcript as string) ?? this.currentTurnDelta;
        if (turnText) {
          this.completedTurns = (this.completedTurns + " " + turnText).trim();
        }
        this.currentTurnDelta = "";
        // If the client already requested final, this is the last turn we
        // were waiting for — finalize. Otherwise just keep streaming.
        if (this.awaitingFinal) {
          void this.runCleanupAndClose();
        } else {
          // Push the latest accumulated transcript so the client UI sees
          // committed text even between turns.
          this.sendClient({ type: "partial", text: this.completedTurns });
        }
        break;
      }
      case "error": {
        const code = data.error?.code as string | undefined;
        // server_vad may have already committed everything; our manual
        // commit then errors with "buffer too small". That's normal —
        // finalize with whatever we accumulated.
        if (code === "input_audio_buffer_commit_empty" && this.awaitingFinal) {
          void this.runCleanupAndClose();
          break;
        }
        this.sendClient({
          type: "error",
          message: data.error?.message ?? "openai error",
        });
        this.close(1011, "upstream error");
        break;
      }
    }
  }

  private onUpstreamError(_ev: Event): void {
    this.sendClient({ type: "error", message: "upstream connection error" });
    this.close(1011, "upstream error");
  }

  private onUpstreamClose(): void {
    // If we never produced a final, surface that to the client so it
    // can fall back to /transcribe HTTP.
    if (!this.completedTurns && !this.closed) {
      this.sendClient({
        type: "error",
        message: "upstream closed before final transcript",
      });
      this.close(1011, "upstream closed");
    }
  }

  private async runCleanupAndClose(): Promise<void> {
    if (this.closed) return;
    // Avoid running twice if both a completed event and the safety-net
    // timeout fire close together.
    this.awaitingFinal = false;
    const raw = (this.completedTurns + " " + this.currentTurnDelta).trim();
    this.sendClient({ type: "final_raw", text: raw });
    try {
      const clean = await postprocessText(raw, this.style);
      this.sendClient({ type: "final_clean", text: clean });
    } catch (err) {
      this.sendClient({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.close(1000, "done");
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private forwardAudio(buf: ArrayBuffer): void {
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audio = btoa(binary);
    this.sendUpstream({ type: "input_audio_buffer.append", audio });
    // 16-bit samples → 2 bytes each. Tracked for the auto-commit ticker.
    this.samplesSinceCommit += bytes.length / 2;
  }

  private sendUpstream(msg: object): void {
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(JSON.stringify(msg));
    }
  }

  private sendClient(ev: ServerToClientEvent): void {
    if (this.closed) return;
    try {
      this.client.send(JSON.stringify(ev));
    } catch {
      /* client gone */
    }
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAutoCommit();
    try { this.upstream?.close(); } catch { /* noop */ }
    this.upstream = null;
    try { this.client.close(code, reason); } catch { /* noop */ }
  }
}
