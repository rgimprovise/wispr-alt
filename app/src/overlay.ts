import { listen } from "@tauri-apps/api/event";

type State = "idle" | "recording" | "transcribing";

interface StateChangePayload {
  state: State;
  text?: string;
}

const pill = document.getElementById("pill") as HTMLDivElement;
const textEl = document.getElementById("text") as HTMLDivElement;
const windowEl = document.getElementById("window") as HTMLDivElement;

// ─── Smooth teletype scroll ───────────────────────────────────────────────
//
// Rate-limited velocity controller (trapezoidal profile). Each frame:
//   desired_v = sign(dx) · min(V_MAX, |dx| · K)
//   v        += clamp(desired_v − v, ±A_MAX)
//   offset   += v
//
// Effect:
//   - far from target → v ramps smoothly from 0 up to V_MAX over ~300ms
//   - cruising        → v stays at V_MAX
//   - approaching     → desired_v decays linearly, v smoothly follows down
//   - arrived         → v decays to 0, loop exits
//
// No instantaneous velocity changes anywhere → no visual jumps.

const V_MAX = 1.8;   // px/frame max speed (~108 px/s at 60fps; ~9 chars/sec)
const A_MAX = 0.07;  // px/frame² max acceleration (reaches V_MAX in ~26 frames ≈ 430ms)
const K = 0.15;      // gain for deceleration near target (starts slowing below ~12px)
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

  // Stop condition: close enough AND moving slowly enough.
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
  if (rafHandle === null) {
    rafHandle = requestAnimationFrame(animate);
  }
}

function recomputeTarget() {
  const overflow = Math.max(0, textEl.scrollWidth - windowEl.clientWidth);
  targetOffset = overflow;
  kickAnimation();
}

function render(state: State, text?: string) {
  pill.className = `pill pill--${state}`;

  const display =
    text && text.trim().length > 0
      ? text
      : state === "recording"
      ? "listening…"
      : state === "transcribing"
      ? "transcribing…"
      : "idle";

  // If state changed to a short placeholder, snap back to the start.
  const isPlaceholder = !text || text.trim().length === 0;
  textEl.textContent = display;

  if (isPlaceholder) {
    // Snap instantly (no scroll needed for placeholder text).
    currentOffset = 0;
    targetOffset = 0;
    velocity = 0;
    applyTransform();
    return;
  }

  // Measure in the next frame so the browser has applied the new textContent.
  requestAnimationFrame(recomputeTarget);
}

// Initial state
render("idle");

listen<StateChangePayload>("overlay-state", (e) => {
  render(e.payload.state, e.payload.text);
});

// Re-align on window resize (rare, but keeps us robust)
window.addEventListener("resize", recomputeTarget);
