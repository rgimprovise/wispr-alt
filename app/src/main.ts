import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type RecordingState = "idle" | "recording" | "transcribing";

// TODO: make configurable in Settings UI. For dev, hardcoded.
const BACKEND_URL =
  (import.meta as any).env?.VITE_BACKEND_URL ?? "http://localhost:8787";

let state: RecordingState = "idle";

function setStatus(next: RecordingState, detail?: string) {
  state = next;
  const el = document.querySelector<HTMLDivElement>("#status");
  if (!el) return;
  el.className = `status status--${next}`;
  el.textContent = detail ? `${next} — ${detail}` : next;
}

function log(msg: string) {
  const el = document.querySelector<HTMLPreElement>("#log");
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 19);
  el.textContent = `[${ts}] ${msg}\n` + el.textContent;
}

async function startRecording() {
  try {
    await invoke("start_recording");
    setStatus("recording");
    log("recording started");
  } catch (err) {
    log(`start failed: ${err}`);
    setStatus("idle");
  }
}

async function stopAndTranscribe() {
  try {
    setStatus("transcribing");
    const wavBytes = (await invoke("stop_recording")) as number[];
    log(`captured ${wavBytes.length} bytes WAV`);

    if (wavBytes.length < 2000) {
      log("too short — skipping upload");
      setStatus("idle");
      return;
    }

    const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
    const form = new FormData();
    form.append("audio", blob, "recording.wav");
    form.append("postprocess", "true");

    const t0 = performance.now();
    const res = await fetch(`${BACKEND_URL}/transcribe`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new Error(`backend ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      raw: string;
      clean: string;
      latencyMs: { total: number };
    };
    const dt = Math.round(performance.now() - t0);
    log(`transcribed in ${dt}ms: "${json.clean.slice(0, 80)}"`);

    if (json.clean.trim().length > 0) {
      await invoke("paste", { text: json.clean });
    }
    setStatus("idle");
  } catch (err) {
    log(`transcribe failed: ${err}`);
    setStatus("idle");
  }
}

async function onHotkey() {
  if (state === "idle") {
    await startRecording();
  } else if (state === "recording") {
    await stopAndTranscribe();
  }
  // ignore presses while transcribing
}

window.addEventListener("DOMContentLoaded", () => {
  setStatus("idle");

  listen("hotkey-pressed", () => {
    onHotkey();
  });

  document.querySelector("#test-paste")?.addEventListener("click", async () => {
    try {
      await invoke("paste", { text: "wispr-alt test injection ✓" });
      log("paste invoked");
    } catch (err) {
      log(`paste failed: ${err}`);
    }
  });
});
