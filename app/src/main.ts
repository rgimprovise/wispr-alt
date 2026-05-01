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
    const label = el.querySelector<HTMLSpanElement>(".status__label");
    if (label) {
      label.textContent = detail ? `${next} · ${detail}` : next;
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
      await emit("overlay-visible", true);
    } else {
      // Play exit animation first, then hide at OS level.
      await emit("overlay-visible", false);
      await new Promise((r) => setTimeout(r, ANIM_MS));
      await overlay.hide();
      log("overlay hidden");
    }
  } catch (err) {
    log(`overlay toggle failed: ${err}`);
  }
}

function updateOverlay(s: RecordingState, text: string) {
  emit("overlay-state", { state: s, text });
}

// In-memory mirror of the JWT loaded from Rust settings on startup. Kept
// here so the hot path (snapshot tick → /transcribe) doesn't pay an IPC
// round-trip per request. Updated by signIn() / signOut().
let authToken: string | null = null;

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
  // Read current style from Rust settings (persisted across launches).
  try {
    const style = (await invoke("get_style")) as string;
    if (style) form.append("style", style);
  } catch {
    /* style optional; backend defaults to "clean" */
  }
  const res = await authedFetch("/transcribe", { method: "POST", body: form });
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
        "accessibility: NOT GRANTED — System Settings → Privacy & Security → Accessibility → add wispr-alt → restart app"
      );
    }
  } catch (err) {
    log(`accessibility check failed: ${err}`);
  }

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

  document.querySelector("#logout-btn")?.addEventListener("click", async () => {
    await signOut();
  });

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

function showAuthStep(step: "email" | "code"): void {
  const emailStep = document.getElementById("auth-step-email");
  const codeStep = document.getElementById("auth-step-code");
  if (step === "email") {
    emailStep?.removeAttribute("hidden");
    codeStep?.setAttribute("hidden", "");
    (document.getElementById("auth-email") as HTMLInputElement | null)?.focus();
  } else {
    emailStep?.setAttribute("hidden", "");
    codeStep?.removeAttribute("hidden");
    (document.getElementById("auth-code") as HTMLInputElement | null)?.focus();
  }
}

function showAuthError(target: "email" | "code", message: string): void {
  const el = document.getElementById(`auth-${target}-error`);
  if (!el) return;
  el.textContent = message;
  el.removeAttribute("hidden");
}

function clearAuthErrors(): void {
  for (const id of ["auth-email-error", "auth-code-error"]) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      el.setAttribute("hidden", "");
    }
  }
}

function wireAuth(): void {
  let pendingEmail = "";

  const emailForm = document.getElementById("auth-email-form") as HTMLFormElement | null;
  emailForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearAuthErrors();
    const input = document.getElementById("auth-email") as HTMLInputElement;
    const submit = document.getElementById("auth-email-submit") as HTMLButtonElement;
    const email = input.value.trim().toLowerCase();
    if (!email) return;
    submit.disabled = true;
    submit.textContent = "Отправляем…";
    try {
      const res = await fetch(`${BACKEND_URL}/auth/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      pendingEmail = email;
      const display = document.getElementById("auth-email-display");
      if (display) display.textContent = email;
      showAuthStep("code");
    } catch (err) {
      showAuthError("email", err instanceof Error ? err.message : String(err));
    } finally {
      submit.disabled = false;
      submit.textContent = "Прислать код";
    }
  });

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
      authToken = body.token;
      await invoke("set_auth_session", {
        token: body.token,
        email: body.user.email,
      });
      showMain(body.user.email);
      initMainApp();
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
}

async function signOut(): Promise<void> {
  authToken = null;
  try {
    await invoke("clear_auth_session");
  } catch (err) {
    log(`clear_auth_session failed: ${err}`);
  }
  showAuthGate();
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
