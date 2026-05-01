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
  /** Concatenation of all completed turns so far (server_vad may auto-commit
   *  several times during one recording). */
  private completedTurns = "";
  /** Set when the client has sent `commit` and we're waiting for the last
   *  completed event before running cleanup. */
  private awaitingFinal = false;
  /** Whether server_vad created the session — we only send manual commits
   *  to flush trailing audio. */
  private closed = false;

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
      // server_vad may already have committed everything during silence.
      // We still send a manual commit to flush any trailing audio that
      // hasn't tripped the VAD threshold; if the buffer is empty OpenAI
      // returns an `input_audio_buffer_commit_empty` error which we treat
      // as "nothing more to wait for" and finalize immediately.
      this.awaitingFinal = true;
      this.sendUpstream({ type: "input_audio_buffer.commit" });
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
        // server_vad gives us live deltas as the user speaks. It also
        // auto-commits on silence, which produces multiple completed
        // events per recording — we concatenate them in completedTurns
        // and emit final_clean after the client's commit signal.
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 200,
          silence_duration_ms: 500,
        },
      },
    });
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
    // Base64-encode the raw PCM and wrap as input_audio_buffer.append.
    // Bun.btoa handles binary strings correctly in v1.x.
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const audio = btoa(binary);
    this.sendUpstream({ type: "input_audio_buffer.append", audio });
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
    try { this.upstream?.close(); } catch { /* noop */ }
    this.upstream = null;
    try { this.client.close(code, reason); } catch { /* noop */ }
  }
}
