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
  /** Accumulates `delta` text so we can fall back if `completed` never arrives. */
  private partialAccum = "";
  /** Raw transcript from `…transcription.completed`. Set once. */
  private finalRaw: string | null = null;
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
      this.sendUpstream({ type: "input_audio_buffer.commit" });
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
        // Manual commit — we send `input_audio_buffer.commit` when the
        // client releases the record gesture. Server VAD added later.
        turn_detection: null,
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
          this.partialAccum += delta;
          this.sendClient({ type: "partial", text: this.partialAccum });
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        this.finalRaw = (data.transcript as string) ?? this.partialAccum;
        this.sendClient({ type: "final_raw", text: this.finalRaw });
        // Cleanup happens off the upstream-message thread to keep this
        // handler tight.
        void this.runCleanupAndClose();
        break;
      case "error":
        this.sendClient({
          type: "error",
          message: data.error?.message ?? "openai error",
        });
        this.close(1011, "upstream error");
        break;
    }
  }

  private onUpstreamError(_ev: Event): void {
    this.sendClient({ type: "error", message: "upstream connection error" });
    this.close(1011, "upstream error");
  }

  private onUpstreamClose(): void {
    // If we never produced a final, surface that to the client so it
    // can fall back to /transcribe HTTP.
    if (!this.finalRaw && !this.closed) {
      this.sendClient({
        type: "error",
        message: "upstream closed before final transcript",
      });
      this.close(1011, "upstream closed");
    }
  }

  private async runCleanupAndClose(): Promise<void> {
    const raw = this.finalRaw ?? "";
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
