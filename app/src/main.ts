import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

type RecordingState = "idle" | "recording" | "transcribing";

const BACKEND_URL =
  (import.meta as any).env?.VITE_BACKEND_URL ?? "http://localhost:8787";

let state: RecordingState = "idle";
let snapshotInFlight = false;
let lastPartial = "";
let snapshotSeq = 0; // guard against late responses overwriting fresher ones

function setStatus(next: RecordingState, detail?: string) {
  state = next;
  const el = document.querySelector<HTMLDivElement>("#status");
  if (el) {
    el.className = `status status--${next}`;
    el.textContent = detail ? `${next} — ${detail}` : next;
  }
  updateOverlay(next, lastPartial);
}

function log(msg: string) {
  const el = document.querySelector<HTMLPreElement>("#log");
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 19);
  el.textContent = `[${ts}] ${msg}\n` + el.textContent;
}

async function setOverlayVisible(visible: boolean) {
  try {
    const windows = await getAllWebviewWindows();
    const overlay = windows.find((w) => w.label === "overlay");
    if (!overlay) return;
    if (visible) await overlay.show();
    else await overlay.hide();
  } catch (err) {
    console.error("overlay toggle", err);
  }
}

function updateOverlay(s: RecordingState, text: string) {
  emit("overlay-state", { state: s, text });
}

async function transcribePartial(wavBytes: number[]): Promise<string | null> {
  if (wavBytes.length < 4000) return null; // too short, skip
  const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
  const form = new FormData();
  form.append("audio", blob, "partial.wav");
  form.append("postprocess", "false");
  const res = await fetch(`${BACKEND_URL}/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { raw: string };
  return json.raw.trim();
}

async function transcribeFinal(wavBytes: number[]): Promise<string> {
  const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
  const form = new FormData();
  form.append("audio", blob, "final.wav");
  form.append("postprocess", "true");
  const res = await fetch(`${BACKEND_URL}/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { clean: string };
  return json.clean.trim();
}

async function tickSnapshot() {
  if (state !== "recording") return;
  if (snapshotInFlight) return; // skip if previous not finished
  snapshotInFlight = true;
  const mySeq = ++snapshotSeq;
  try {
    const wav = (await invoke("snapshot_recording")) as number[];
    log(`snapshot: ${wav.length} bytes, posting…`);
    const text = await transcribePartial(wav);
    if (mySeq === snapshotSeq && state === "recording" && text) {
      lastPartial = text;
      updateOverlay("recording", text);
      log(`partial: "${text.slice(0, 60)}"`);
    } else if (!text) {
      log(`partial: (empty, wav too short?)`);
    }
  } catch (err) {
    log(`snapshot failed: ${err}`);
  } finally {
    snapshotInFlight = false;
  }
}

async function startRecording() {
  try {
    lastPartial = "";
    snapshotSeq = 0;
    snapshotInFlight = false;
    await invoke("start_recording"); // Rust spawns its own ticker thread
    setStatus("recording");
    await setOverlayVisible(true);
    log("recording started");
  } catch (err) {
    log(`start failed: ${err}`);
    setStatus("idle");
  }
}

async function stopAndFinalize() {
  try {
    // invalidate any pending snapshot responses
    snapshotSeq++;

    setStatus("transcribing", lastPartial ? `preview: ${lastPartial.slice(0, 40)}` : undefined);
    const wav = (await invoke("stop_recording")) as number[];
    log(`captured ${wav.length} bytes WAV total`);

    if (wav.length < 4000) {
      log("too short — skipping");
      await setOverlayVisible(false);
      setStatus("idle");
      return;
    }

    const t0 = performance.now();
    const clean = await transcribeFinal(wav);
    const dt = Math.round(performance.now() - t0);
    log(`final transcribed in ${dt}ms: "${clean.slice(0, 80)}"`);

    if (clean.length > 0) {
      updateOverlay("transcribing", clean);
      // small delay so user sees the final text briefly before overlay hides
      await new Promise((r) => setTimeout(r, 150));
      await invoke("paste", { text: clean });
    }
    await setOverlayVisible(false);
    setStatus("idle");
  } catch (err) {
    log(`transcribe failed: ${err}`);
    await setOverlayVisible(false);
    setStatus("idle");
  }
}

async function onHotkey() {
  if (state === "idle") {
    await startRecording();
  } else if (state === "recording") {
    await stopAndFinalize();
  }
  // ignore presses while transcribing
}

window.addEventListener("DOMContentLoaded", () => {
  setStatus("idle");

  listen("hotkey-pressed", () => {
    onHotkey();
  });

  // Rust-driven snapshot ticker (immune to WKWebView background throttling).
  listen("snapshot-tick", () => {
    tickSnapshot();
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
