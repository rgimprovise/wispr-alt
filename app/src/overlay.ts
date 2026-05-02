import { listen } from "@tauri-apps/api/event";

type State = "idle" | "recording" | "transcribing";

interface StateChangePayload {
  state: State;
  text?: string;
}

// ─── DOM refs ──────────────────────────────────────────────────────────────
const pill = document.getElementById("pill") as HTMLDivElement;
const stateLabel = document.getElementById("state-label") as HTMLSpanElement;
const timerEl = document.getElementById("timer") as HTMLSpanElement;
const textEl = document.getElementById("text") as HTMLDivElement;
const windowEl = document.getElementById("window") as HTMLDivElement;

// ─── Smooth teletype scroll ───────────────────────────────────────────────
// Rate-limited velocity controller — trapezoidal profile.
// Keeps the right edge of the text aligned with the right edge of the
// window; new words appear on the right, older text scrolls out left.

const V_MAX = 1.8;
const A_MAX = 0.07;
const K = 0.15;
const EPS_POS = 0.4;
const EPS_VEL = 0.05;

let currentOffset = 0;
let targetOffset = 0;
let velocity = 0;
let rafHandle: number | null = null;

function applyTransform() {
  textEl.style.transform = `translateX(${-currentOffset}px)`;
}

function animate() {
  const dx = targetOffset - currentOffset;
  if (Math.abs(dx) < EPS_POS && Math.abs(velocity) < EPS_VEL) {
    currentOffset = targetOffset;
    velocity = 0;
    applyTransform();
    rafHandle = null;
    return;
  }
  const sign = Math.sign(dx);
  const desiredSpeed = Math.min(V_MAX, Math.abs(dx) * K);
  const desiredVelocity = sign * desiredSpeed;
  const dv = desiredVelocity - velocity;
  if (Math.abs(dv) > A_MAX) {
    velocity += Math.sign(dv) * A_MAX;
  } else {
    velocity = desiredVelocity;
  }
  currentOffset += velocity;
  applyTransform();
  rafHandle = requestAnimationFrame(animate);
}

function kickAnimation() {
  if (rafHandle === null) rafHandle = requestAnimationFrame(animate);
}

function recomputeTarget() {
  const overflow = Math.max(0, textEl.scrollWidth - windowEl.clientWidth);
  targetOffset = overflow;
  kickAnimation();
}

// ─── Timer ─────────────────────────────────────────────────────────────────
let recordingStartedAt: number | null = null;
let timerInterval: number | null = null;

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function startTimer() {
  recordingStartedAt = performance.now();
  timerEl.textContent = "0:00";
  if (timerInterval !== null) window.clearInterval(timerInterval);
  timerInterval = window.setInterval(() => {
    if (recordingStartedAt === null) return;
    const ms = performance.now() - recordingStartedAt;
    timerEl.textContent = formatDuration(ms);
  }, 250);
}

function freezeTimer() {
  if (timerInterval !== null) {
    window.clearInterval(timerInterval);
    timerInterval = null;
  }
  // Leave the displayed value as-is so user sees duration during transcribing.
}

function resetTimer() {
  freezeTimer();
  recordingStartedAt = null;
  timerEl.textContent = "0:00";
}

// ─── State machine / render ────────────────────────────────────────────────
const STATE_LABEL: Record<State, string> = {
  idle: "Готов",
  recording: "Запись",
  transcribing: "Расшифровка",
};

const FOOT_LABEL: Record<State, string> = {
  idle: "Удерживайте чтобы записать",
  recording: "Отпустите — отправим",
  transcribing: "Чистим текст…",
};

let prevState: State = "idle";

function render(state: State, text?: string) {
  pill.dataset.state = state;
  pill.className = `pill pill--${state}`;
  stateLabel.textContent = STATE_LABEL[state];
  const footLabel = document.getElementById("foot-label");
  if (footLabel) footLabel.textContent = FOOT_LABEL[state];

  // Timer transitions
  if (state === "recording" && prevState !== "recording") startTimer();
  if (state === "transcribing" && prevState === "recording") freezeTimer();
  if (state === "idle" && prevState !== "idle") resetTimer();
  prevState = state;

  const hasText = !!text && text.trim().length > 0;
  if (!hasText) {
    textEl.textContent = "";
    currentOffset = 0;
    targetOffset = 0;
    velocity = 0;
    applyTransform();
    return;
  }

  textEl.textContent = text!;
  requestAnimationFrame(recomputeTarget);
}

render("idle");

// ─── Event wiring ──────────────────────────────────────────────────────────
//
// Heartbeat indicator: every overlay-state event flashes data-beat="1" on
// the pill for 200 ms. CSS turns this into a small dot pulse. Lets the
// user see at a glance whether snapshot-tick events from main are reaching
// the overlay at all, even when the transcribed text comes back empty
// (silence / background noise / very short snapshot).
let beatTimer: number | null = null;
function flashHeartbeat() {
  pill.dataset.beat = "1";
  if (beatTimer !== null) window.clearTimeout(beatTimer);
  beatTimer = window.setTimeout(() => {
    pill.dataset.beat = "0";
    beatTimer = null;
  }, 200);
}

listen<StateChangePayload>("overlay-state", (e) => {
  flashHeartbeat();
  render(e.payload.state, e.payload.text);
});

// Show/hide animation is driven by the main window so exit plays BEFORE
// the OS-level hide. We simply toggle the .visible class on <body> and CSS
// handles the transform + opacity transition.
listen<boolean>("overlay-visible", (e) => {
  document.body.classList.toggle("visible", e.payload);
});

window.addEventListener("resize", recomputeTarget);
