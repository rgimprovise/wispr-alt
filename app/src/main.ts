import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

type RecordingState = "idle" | "recording" | "transcribing";

const BACKEND_URL =
  (import.meta as any).env?.VITE_BACKEND_URL ?? "http://localhost:8787";

let state: RecordingState = "idle";
let snapshotInFlight = false;
let lastPartial = "";
let snapshotSeq = 0; // guard against late responses overwriting fresher ones

// Brand voice: status labels are short, in lowercase Russian. See BRAND.md.
const STATUS_LABEL: Record<RecordingState, string> = {
  idle: "готов слушать",
  recording: "слушаю",
  transcribing: "структурирую",
};

function setStatus(next: RecordingState, detail?: string) {
  state = next;
  const el = document.querySelector<HTMLDivElement>("#status");
  if (el) {
    el.className = `status status--${next}`;
    const label = el.querySelector<HTMLSpanElement>(".status__label");
    if (label) {
      const base = STATUS_LABEL[next];
      label.textContent = detail ? `${base} · ${detail}` : base;
    }
  }
  updateOverlay(next, lastPartial);
}

function log(msg: string) {
  const el = document.querySelector<HTMLPreElement>("#log");
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 19);
  el.textContent = `[${ts}] ${msg}\n` + el.textContent;
}

const ANIM_MS = 220;

async function setOverlayVisible(visible: boolean) {
  try {
    const windows = await getAllWebviewWindows();
    const overlay = windows.find((w) => w.label === "overlay");
    if (!overlay) {
      log(`overlay window NOT FOUND (have: ${windows.map((w) => w.label).join(",")})`);
      return;
    }

    if (visible) {
      await overlay.show();
      // Re-apply NSWindow collection behavior + level every time we show,
      // so the overlay floats above full-screen macOS apps.
      try {
        await invoke("configure_overlay");
      } catch (err) {
        log(`configure_overlay failed: ${err}`);
      }
      log("overlay shown");
      await new Promise((r) => setTimeout(r, 16));
      await emitTo("overlay", "overlay-visible", true);
    } else {
      // Play exit animation first, then hide at OS level.
      await emitTo("overlay", "overlay-visible", false);
      await new Promise((r) => setTimeout(r, ANIM_MS));
      await overlay.hide();
      log("overlay hidden");
    }
  } catch (err) {
    log(`overlay toggle failed: ${err}`);
  }
}

interface OverlayDebug {
  tick?: number;
  wavBytes?: number;
  rawChars?: number;
  note?: string;
}

function updateOverlay(s: RecordingState, text: string, debug?: OverlayDebug) {
  // emitTo target the overlay webview directly. Plain emit() in Tauri 2
  // is supposed to be a broadcast, but on macOS we observed live-preview
  // updates not reaching the overlay window during recording — likely
  // because the main webview is backgrounded the moment the user focuses
  // their target app, and global emit can be deferred. Targeted emitTo
  // bypasses that path and delivers straight to the overlay's listener.
  emitTo("overlay", "overlay-state", { state: s, text, debug });
}

// In-memory mirror of the JWT loaded from Rust settings on startup. Kept
// here so the hot path (snapshot tick → /transcribe) doesn't pay an IPC
// round-trip per request. Updated by signIn() / signOut().
let authToken: string | null = null;

// True streaming via /transcribe-stream WS exists in the backend but is
// not used from desktop right now — see stopAndFinalize for the snapshot
// pattern (rolling 5-second window, 1 s tick, full WAV on stop).

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  if (!authToken) throw new Error("not signed in");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${authToken}`);
  const res = await fetch(`${BACKEND_URL}${path}`, { ...init, headers });
  if (res.status === 401) {
    // Token expired or revoked. Drop session and force re-auth.
    log("session expired — please sign in again");
    await signOut();
    throw new Error("session expired");
  }
  return res;
}

async function transcribePartial(wavBytes: number[]): Promise<string | null> {
  if (wavBytes.length < 4000) return null; // too short, skip
  const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
  const form = new FormData();
  form.append("audio", blob, "partial.wav");
  form.append("postprocess", "false");
  const res = await authedFetch("/transcribe", { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { raw: string };
  return json.raw.trim();
}

async function transcribeFinal(wavBytes: number[]): Promise<string> {
  const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
  const form = new FormData();
  form.append("audio", blob, "final.wav");
  form.append("postprocess", "true");
  try {
    const style = (await invoke("get_style")) as string;
    if (style) form.append("style", style);
  } catch { /* default */ }

  // Stream mode (?stream=1): server sends NDJSON
  //   {type:"raw",text}      ~1-2s after stop, raw transcription done
  //   {type:"delta",text}    repeated, LLM cleanup chunks
  //   {type:"done",text}     full clean text, ready to paste
  // Updating the overlay on each event makes the wall-clock identical
  // but the perceived latency much shorter — text starts streaming in
  // immediately after stop instead of going dark for 4-6s.
  //
  // Two-tier timeout. A single 60s ceiling was too tight for 2-minute
  // dictations: transcribeOnly alone takes 15-30s on the OpenAI side,
  // then cleanup streams for another 30-60s+, blowing past the budget
  // and leaving the overlay frozen.
  //
  //   inactivityMs — abort if no NDJSON event for 45s. Picks up real
  //                  hangs (TLS stall, OpenAI dead, nginx buffering)
  //                  while letting healthy long requests run.
  //   hardCapMs    — absolute cap so a slow trickle can't stall forever.
  //
  // On any abort we still return raw if we received it; the user gets
  // their transcript pasted instead of staring at "структурирую".
  const ac = new AbortController();
  const inactivityMs = 45_000;
  const hardCapMs = 180_000;
  let inactivityTimer = setTimeout(() => ac.abort(), inactivityMs);
  const hardTimer = setTimeout(() => ac.abort(), hardCapMs);
  const bumpInactivity = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => ac.abort(), inactivityMs);
  };
  let raw = "";
  let clean = "";
  try {
    const res = await authedFetch("/transcribe?stream=1", {
      method: "POST",
      body: form,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    if (!res.body) throw new Error("no response body");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let finished = false; // set on `done` event — break the read loop early
    outer: while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      bumpInactivity();
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev: { type: string; text?: string; message?: string };
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "raw") {
          raw = ev.text ?? "";
          // Show raw text as soon as transcription finishes so the user
          // sees something immediately. Cleanup deltas will overwrite.
          updateOverlay("transcribing", raw);
          log(`raw received (${raw.length} chars)`);
        } else if (ev.type === "delta") {
          clean += ev.text ?? "";
          updateOverlay("transcribing", clean);
        } else if (ev.type === "done") {
          clean = (ev.text ?? clean).trim();
          // Don't wait for reader to deliver {done:true} — nginx buffering
          // or keep-alive between us and the backend can hold the socket
          // open for tens of seconds after the body is fully received.
          // The previous version froze in `transcribing` until the hard
          // timeout fired even though all content had already arrived.
          finished = true;
          try { await reader.cancel(); } catch { /* socket already gone */ }
          break outer;
        } else if (ev.type === "error") {
          throw new Error(ev.message ?? "transcribe error");
        }
      }
    }
  } catch (err) {
    // Timeout / network drop → use whatever we accumulated. Better to
    // paste raw than to leave the user staring at a frozen overlay.
    if ((err as any)?.name === "AbortError") {
      log(`transcribe stream timeout (raw=${raw.length}, clean=${clean.length}) — falling back`);
    } else {
      log(`transcribe stream error: ${err}`);
    }
  } finally {
    clearTimeout(inactivityTimer);
    clearTimeout(hardTimer);
  }
  return clean.trim() || raw.trim();
}

let tickCounter = 0;

async function tickSnapshot() {
  if (state !== "recording") return;
  if (snapshotInFlight) return; // skip if previous not finished
  snapshotInFlight = true;
  const mySeq = ++snapshotSeq;
  const myTick = ++tickCounter;
  try {
    // Rolling 8 s window: live preview shows the trailing audio, which
    // keeps each /transcribe call small (~250 KB WAV) and the request
    // round-trip well under the 1 s tick. The earlier "full buffer per
    // tick" approach grew to 5+ MB on 2-min recordings, blocked tick
    // overlap (snapshotInFlight stayed true), and is what was breaking
    // live preview on long sessions.
    const wav = (await invoke("snapshot_recent", { seconds: 8 })) as number[];
    if (wav.length < 4000) {
      log(`tick #${myTick}: wav too short (${wav.length} bytes)`);
      // still flash heartbeat / debug — overlay is interested in liveness
      updateOverlay("recording", lastPartial, {
        tick: myTick, wavBytes: wav.length, note: "wav too short",
      });
      return;
    }
    let text: string | null = null;
    let errNote: string | undefined;
    try {
      text = await transcribePartial(wav);
    } catch (err) {
      // Capture HTTP failures so we can surface them on the overlay
      // diagnostic strip instead of silently logging only.
      errNote = `error: ${String(err).slice(0, 40)}`;
      log(`partial fetch failed: ${err}`);
    }
    if (mySeq === snapshotSeq && state === "recording") {
      if (text) {
        lastPartial = text;
        log(`partial #${myTick}: "${text.slice(0, 60)}" (${text.length} chars)`);
      } else if (!errNote) {
        log(`tick #${myTick}: empty text from /transcribe (silence?)`);
      }
      updateOverlay("recording", lastPartial, {
        tick: myTick,
        wavBytes: wav.length,
        rawChars: text ? text.length : 0,
        note: errNote,
      });
    }
  } catch (err) {
    log(`snapshot failed: ${err}`);
    updateOverlay("recording", lastPartial, {
      tick: myTick, note: `snapshot fail: ${String(err).slice(0, 40)}`,
    });
  } finally {
    snapshotInFlight = false;
  }
}

async function startRecording() {
  try {
    // Recover from a desynced state where Rust thinks it's recording
    // but the JS UI is back at idle (HMR leftovers, prior crash, etc).
    try {
      if ((await invoke("is_recording")) as boolean) {
        try { await invoke("stop_recording"); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    lastPartial = "";
    snapshotSeq = 0;
    snapshotInFlight = false;
    tickCounter = 0;

    await invoke("start_recording", { streaming: false });
    setStatus("recording");
    await setOverlayVisible(true);
    log("recording started");
  } catch (err) {
    log(`start failed: ${err}`);
    setStatus("idle");
    try { await invoke("stop_recording"); } catch { /* noop */ }
  }
}

/**
 * Opens the /transcribe-stream WebSocket and resolves with it once the
 * server emits `{type:"ready"}` (i.e. the OpenAI handshake is done and
 * we can start sending audio). Rejects on early close or 2 s timeout.
 */
async function stopAndFinalize() {
  try {
    snapshotSeq++; // invalidate any pending snapshot responses

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
      await invoke("paste", { text: clean });
      // Leave the cleaned transcript visible briefly so the user gets
      // confirmation of what was inserted before the overlay slides out.
      await new Promise((r) => setTimeout(r, 600));
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

window.addEventListener("DOMContentLoaded", async () => {
  setStatus("idle");
  wireAuth();

  // agolos://auth?token=…&email=… — Rust persisted the session before
  // emitting; we just refresh in-memory state and swap surfaces.
  listen("auth-deep-link", (event) => {
    const payload = event.payload as { token: string; email: string };
    authToken = payload.token;
    showMain(payload.email);
    void initMainApp();
  });

  // Decide which surface to show: signed-in user → main app; otherwise
  // the email-entry step of the auth gate.
  const stored = (await invoke("get_auth_token")) as string | null;
  const email = (await invoke("get_auth_email")) as string | null;
  if (stored && email) {
    authToken = stored;
    showMain(email);
    initMainApp();
  } else {
    showAuthGate();
  }
});

// Track listener registration so Vite HMR re-runs of initMainApp don't
// double-register `hotkey-pressed` / tick handlers (which causes
// concurrent startRecording calls and the "already recording" cascade).
let mainAppWired = false;

async function initMainApp() {
  // Check Accessibility permission status and surface it to the log so the
  // user can tell at a glance if paste will work. The same call also
  // triggers the native prompt if we're not yet trusted.
  try {
    const trusted = (await invoke("check_accessibility")) as boolean;
    if (trusted) {
      log("accessibility: OK");
    } else {
      log(
        "accessibility: NOT GRANTED — System Settings → Privacy & Security → Accessibility → add А-ГОЛОС → restart app"
      );
    }
  } catch (err) {
    log(`accessibility check failed: ${err}`);
  }

  if (!mainAppWired) {
    mainAppWired = true;
    listen("hotkey-pressed", () => {
      onHotkey();
    });

    // Rust-driven snapshot ticker (immune to WKWebView background throttling).
    listen("snapshot-tick", () => {
      tickSnapshot();
    });

  }

  document.querySelector("#test-paste")?.addEventListener("click", async () => {
    try {
      await invoke("paste", { text: "А-ГОЛОС test injection ✓" });
      log("paste invoked");
    } catch (err) {
      log(`paste failed: ${err}`);
    }
  });

  document.querySelector("#logout-btn")?.addEventListener("click", async () => {
    await signOut();
  });

  await refreshSetPasswordButton();
  wireSetPasswordPanel();

  try {
    const current = (await invoke("get_hotkey")) as string;
    updateHotkeyUI(current);
  } catch (err) {
    log(`failed to load hotkey: ${err}`);
  }
  wireHotkeyPicker();

  try {
    const current = (await invoke("get_style")) as string;
    updateStyleUI(current);
  } catch (err) {
    log(`failed to load style: ${err}`);
  }
  wireStylePicker();

  // App version in the footer — lets a tester report which build they are
  // running. Read from the Tauri runtime, which sources it from
  // tauri.conf.json. Fallback to "—" if the API is unavailable for any
  // reason (older WebView / dev mode race).
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    const el = document.querySelector("#app-version");
    if (el) el.textContent = `v${v}`;
  } catch (err) {
    log(`failed to load app version: ${err}`);
    const el = document.querySelector("#app-version");
    if (el) el.textContent = "—";
  }
}

// ─── Auth UI ───────────────────────────────────────────────────────────────

function showAuthGate(): void {
  document.getElementById("auth-gate")?.removeAttribute("hidden");
  document.getElementById("app-main")?.setAttribute("hidden", "");
  showAuthStep("email");
}

function showMain(email: string): void {
  document.getElementById("auth-gate")?.setAttribute("hidden", "");
  document.getElementById("app-main")?.removeAttribute("hidden");
  const acc = document.getElementById("account-email");
  if (acc) acc.textContent = email;
}

type AuthStep = "email" | "password" | "code";

function showAuthStep(step: AuthStep): void {
  const map: Record<AuthStep, [string, string]> = {
    email: ["auth-step-email", "auth-email"],
    password: ["auth-step-password", "auth-password"],
    code: ["auth-step-code", "auth-code"],
  };
  for (const k of Object.keys(map) as AuthStep[]) {
    document.getElementById(map[k][0])?.setAttribute("hidden", "");
  }
  document.getElementById(map[step][0])?.removeAttribute("hidden");
  (document.getElementById(map[step][1]) as HTMLInputElement | null)?.focus();
}

function showAuthError(target: AuthStep, message: string): void {
  const el = document.getElementById(`auth-${target}-error`);
  if (!el) return;
  el.textContent = message;
  el.removeAttribute("hidden");
}

function clearAuthErrors(): void {
  for (const id of ["auth-email-error", "auth-password-error", "auth-code-error"]) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      el.setAttribute("hidden", "");
    }
  }
}

function wireAuth(): void {
  let pendingEmail = "";

  // Step 1 — submit email. Decide between password and OTP based on
  // /auth/check-email response. Falls back to OTP on network error so
  // the user is never blocked from signing in.
  const emailForm = document.getElementById("auth-email-form") as HTMLFormElement | null;
  emailForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearAuthErrors();
    const input = document.getElementById("auth-email") as HTMLInputElement;
    const submit = document.getElementById("auth-email-submit") as HTMLButtonElement;
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    submit.disabled = true;
    submit.textContent = "Проверяем…";
    try {
      const res = await fetch(`${BACKEND_URL}/auth/check-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        exists?: boolean;
        hasPassword?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      pendingEmail = email;
      if (body.hasPassword) {
        const display = document.getElementById("auth-password-email");
        if (display) display.textContent = email;
        showAuthStep("password");
      } else {
        await sendOtpAndShowCodeStep(email);
      }
    } catch (err) {
      showAuthError("email", err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
      submit.textContent = "Продолжить";
    }
  });

  // Step 2a — password login.
  const passwordForm = document.getElementById("auth-password-form") as HTMLFormElement | null;
  passwordForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearAuthErrors();
    const input = document.getElementById("auth-password") as HTMLInputElement;
    const submit = document.getElementById("auth-password-submit") as HTMLButtonElement;
    const password = input.value;
    if (!password) return;
    submit.disabled = true;
    submit.textContent = "Входим…";
    try {
      const res = await fetch(`${BACKEND_URL}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: pendingEmail, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        user?: { email: string };
        error?: string;
      };
      if (!res.ok || !body.token || !body.user) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      input.value = "";
      await completeSignIn(body.token, body.user.email);
    } catch (err) {
      showAuthError("password", err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
      submit.textContent = "Войти";
    }
  });

  // "Войти по коду из почты" — OTP fallback for users who forgot their password.
  document.getElementById("auth-use-code")?.addEventListener("click", async () => {
    if (!pendingEmail) return;
    clearAuthErrors();
    await sendOtpAndShowCodeStep(pendingEmail);
  });

  document.getElementById("auth-back-from-password")?.addEventListener("click", () => {
    pendingEmail = "";
    clearAuthErrors();
    const pwInput = document.getElementById("auth-password") as HTMLInputElement | null;
    if (pwInput) pwInput.value = "";
    showAuthStep("email");
  });

  // Step 2b — OTP code.
  const codeForm = document.getElementById("auth-code-form") as HTMLFormElement | null;
  codeForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearAuthErrors();
    const input = document.getElementById("auth-code") as HTMLInputElement;
    const submit = document.getElementById("auth-code-submit") as HTMLButtonElement;
    const code = input.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showAuthError("code", "Код состоит из 6 цифр");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Проверяем…";
    try {
      const res = await fetch(`${BACKEND_URL}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: pendingEmail, code }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        user?: { email: string };
        error?: string;
      };
      if (!res.ok || !body.token || !body.user) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      input.value = "";
      await completeSignIn(body.token, body.user.email);
    } catch (err) {
      showAuthError("code", err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
      submit.textContent = "Войти";
    }
  });

  document.getElementById("auth-back")?.addEventListener("click", () => {
    pendingEmail = "";
    clearAuthErrors();
    const codeInput = document.getElementById("auth-code") as HTMLInputElement | null;
    if (codeInput) codeInput.value = "";
    showAuthStep("email");
  });

  async function sendOtpAndShowCodeStep(email: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/auth/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const display = document.getElementById("auth-email-display");
    if (display) display.textContent = email;
    showAuthStep("code");
  }

  async function completeSignIn(token: string, email: string): Promise<void> {
    authToken = token;
    await invoke("set_auth_session", { token, email });
    showMain(email);
    initMainApp();
  }
}

async function signOut(): Promise<void> {
  // Best-effort server-side logout — current backend implementation is a
  // no-op acknowledgement, but calling it gives us future revocation
  // hooks for free and exercises the endpoint in tests.
  if (authToken) {
    try {
      await fetch(`${BACKEND_URL}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch {
      /* offline — proceed with local logout anyway */
    }
  }
  authToken = null;
  try {
    await invoke("clear_auth_session");
  } catch (err) {
    log(`clear_auth_session failed: ${err}`);
  }
  showAuthGate();
}

// ─── Set-password panel ────────────────────────────────────────────────────

/**
 * Polls /auth/check-email for the current user to know whether to label
 * the button "Установить" or "Сменить" (and show the current-password
 * input). Called on initMainApp + after a successful save.
 */
async function refreshSetPasswordButton(): Promise<void> {
  const btn = document.getElementById("set-password-btn") as HTMLButtonElement | null;
  const banner = document.getElementById("set-password-banner");
  if (!btn) return;
  const email = (await invoke("get_auth_email")) as string | null;
  if (!email) return;
  try {
    const res = await fetch(`${BACKEND_URL}/auth/check-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json()) as { hasPassword?: boolean };
    const has = body.hasPassword === true;
    btn.textContent = has ? "Сменить пароль" : "Установить пароль";
    btn.dataset.has = has ? "1" : "0";
    const cur = document.getElementById("set-password-current") as HTMLInputElement | null;
    if (cur) {
      if (has) cur.removeAttribute("hidden");
      else cur.setAttribute("hidden", "");
    }
    // Show the post-login banner only when no password yet AND the
    // user hasn't dismissed it this session. Once they set one (or
    // dismiss), it stays hidden until the session next loads with
    // hasPassword=false again — which by then never happens.
    if (banner) {
      const dismissed = sessionStorage.getItem("setPasswordBannerDismissed") === "1";
      if (!has && !dismissed) banner.removeAttribute("hidden");
      else banner.setAttribute("hidden", "");
    }
  } catch {
    /* leave default label */
  }
}

function wireSetPasswordPanel(): void {
  // Banner buttons (post-login hint when no password yet).
  document.getElementById("banner-set-password")?.addEventListener("click", () => {
    document.getElementById("set-password-banner")?.setAttribute("hidden", "");
    document.getElementById("set-password-btn")?.click();
    document.getElementById("set-password-panel")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  });
  document.getElementById("banner-dismiss")?.addEventListener("click", () => {
    sessionStorage.setItem("setPasswordBannerDismissed", "1");
    document.getElementById("set-password-banner")?.setAttribute("hidden", "");
  });

  const btn = document.getElementById("set-password-btn");
  const panel = document.getElementById("set-password-panel");
  const cancel = document.getElementById("set-password-cancel");
  const form = document.getElementById("set-password-form") as HTMLFormElement | null;
  const errorEl = document.getElementById("set-password-error");
  const successEl = document.getElementById("set-password-success");
  const titleEl = document.getElementById("set-password-title");
  const submitBtn = document.getElementById("set-password-submit") as HTMLButtonElement | null;

  function clearMessages() {
    errorEl?.setAttribute("hidden", "");
    successEl?.setAttribute("hidden", "");
    if (errorEl) errorEl.textContent = "";
    if (successEl) successEl.textContent = "";
  }

  btn?.addEventListener("click", () => {
    clearMessages();
    if (panel?.hasAttribute("hidden")) {
      panel.removeAttribute("hidden");
      if (titleEl) {
        titleEl.textContent =
          (btn as HTMLElement).dataset.has === "1"
            ? "Сменить пароль"
            : "Установить пароль";
      }
      (document.getElementById("set-password-new") as HTMLInputElement | null)?.focus();
    } else {
      panel?.setAttribute("hidden", "");
    }
  });

  cancel?.addEventListener("click", () => {
    clearMessages();
    form?.reset();
    panel?.setAttribute("hidden", "");
  });

  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearMessages();
    const cur = document.getElementById("set-password-current") as HTMLInputElement;
    const next = document.getElementById("set-password-new") as HTMLInputElement;
    const confirm = document.getElementById("set-password-confirm") as HTMLInputElement;
    if (next.value.length < 8) {
      if (errorEl) {
        errorEl.textContent = "Пароль должен быть минимум 8 символов";
        errorEl.removeAttribute("hidden");
      }
      return;
    }
    if (next.value !== confirm.value) {
      if (errorEl) {
        errorEl.textContent = "Пароли не совпадают";
        errorEl.removeAttribute("hidden");
      }
      return;
    }
    if (!authToken) return;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Сохраняем…";
    }
    try {
      const payload: Record<string, string> = { newPassword: next.value };
      if (!cur.hasAttribute("hidden") && cur.value) {
        payload.currentPassword = cur.value;
      }
      const res = await fetch(`${BACKEND_URL}/auth/set-password`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      form.reset();
      if (successEl) {
        successEl.textContent = "Пароль сохранён";
        successEl.removeAttribute("hidden");
      }
      await refreshSetPasswordButton();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err instanceof Error ? err.message : String(err);
        errorEl.removeAttribute("hidden");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Сохранить";
      }
    }
  });
}

// ─── Style picker ──────────────────────────────────────────────────────────

const STYLE_HINTS: Record<string, string> = {
  clean: "Снять «эээ», расставить пунктуацию, разбить на абзацы",
  business: "Формальный рабочий тон, активный залог, структура",
  casual: "Сохранить разговорный тон, мягкая чистка",
  brief: "Только суть, маркированные пункты",
  telegram: "Структурированный пост: крючок, абзацы, без эмодзи",
  email: "Письмо с приветствием, темами и подписью",
  task: "Action-item: контекст, что сделать, срок",
};

function updateStyleUI(style: string) {
  const sel = document.getElementById("style-picker") as HTMLSelectElement | null;
  const hint = document.getElementById("style-hint");
  if (sel) sel.value = style;
  if (hint) hint.textContent = STYLE_HINTS[style] ?? "";
}

function wireStylePicker() {
  const sel = document.getElementById("style-picker") as HTMLSelectElement | null;
  if (!sel) return;
  sel.addEventListener("change", async () => {
    const next = sel.value;
    try {
      await invoke("set_style", { style: next });
      updateStyleUI(next);
      log(`style → ${next}`);
    } catch (err) {
      log(`set_style failed: ${err}`);
      // Revert UI to previously persisted value.
      try {
        const current = (await invoke("get_style")) as string;
        updateStyleUI(current);
      } catch {
        /* noop */
      }
    }
  });
}

// ─── Hotkey picker ─────────────────────────────────────────────────────────

function updateHotkeyUI(combo: string) {
  const pickerLabel = document.getElementById("hotkey-picker-label");
  const hint = document.getElementById("hotkey-hint");
  const display = formatComboForDisplay(combo);
  if (pickerLabel) pickerLabel.textContent = display;
  if (hint) hint.textContent = display;
}

/**
 * Shortcut strings sent to Tauri use the electron format:
 *   "F5", "CmdOrCtrl+Shift+K", "Alt+Space".
 * For display we pretty-print with OS-appropriate glyphs.
 */
function formatComboForDisplay(combo: string): string {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return combo
    .split("+")
    .map((part) => {
      if (!isMac) return part;
      switch (part) {
        case "Cmd":
        case "CmdOrCtrl":
        case "Meta":
        case "Super":
          return "⌘";
        case "Ctrl":
        case "Control":
          return "⌃";
        case "Shift":
          return "⇧";
        case "Alt":
        case "Option":
          return "⌥";
        default:
          return part;
      }
    })
    .join(isMac ? "" : "+");
}

function wireHotkeyPicker() {
  const btn = document.getElementById("hotkey-picker") as HTMLButtonElement | null;
  const label = document.getElementById("hotkey-picker-label");
  if (!btn || !label) return;

  let listening = false;
  let handler: ((e: KeyboardEvent) => void) | null = null;

  const stopListening = () => {
    listening = false;
    if (handler) {
      window.removeEventListener("keydown", handler, true);
      handler = null;
    }
    btn.classList.remove("hotkey-picker--listening");
  };

  btn.addEventListener("click", () => {
    if (listening) return;
    listening = true;
    btn.classList.add("hotkey-picker--listening");
    label.textContent = "Нажмите сочетание…";

    handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore plain modifier presses — wait for a real key.
      if (["Meta", "Control", "Shift", "Alt", "AltGraph"].includes(e.key)) {
        return;
      }

      // Escape cancels.
      if (e.key === "Escape") {
        stopListening();
        // restore last saved
        try {
          const current = (await invoke("get_hotkey")) as string;
          updateHotkeyUI(current);
        } catch {
          /* noop */
        }
        return;
      }

      const combo = comboFromKeyEvent(e);
      stopListening();

      try {
        await invoke("set_hotkey", { combo });
        updateHotkeyUI(combo);
        log(`hotkey changed → ${combo}`);
      } catch (err) {
        log(`set_hotkey failed: ${err}`);
        // Restore previous UI
        try {
          const current = (await invoke("get_hotkey")) as string;
          updateHotkeyUI(current);
        } catch {
          /* noop */
        }
      }
    };
    window.addEventListener("keydown", handler, true);
  });
}

function comboFromKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Cmd");
  parts.push(normalizeKey(e));
  return parts.join("+");
}

/**
 * Convert a KeyboardEvent into the token Tauri's Shortcut::from_str expects.
 * Uses e.code (physical key) so layout doesn't skew e.g. Russian 'в' → 'D'.
 */
function normalizeKey(e: KeyboardEvent): string {
  const code = e.code;

  // Letter keys → single uppercase letter
  const letterMatch = code.match(/^Key([A-Z])$/);
  if (letterMatch) return letterMatch[1];

  // Digit keys
  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) return digitMatch[1];

  // Function keys
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F24

  // Named keys
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    NumpadEnter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
  };
  if (named[code]) return named[code];

  // Fallback to the code itself.
  return code;
}
