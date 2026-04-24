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
// The text element renders at its natural width inside a clipped window.
// We animate `translateX(-offset)` so the right edge of the text stays
// aligned with the right edge of the window (i.e. we always show the
// latest words). A simple lerp towards the target offset gives natural
// deceleration when catching up and automatic stopping when aligned.

const LERP = 0.08; // per-frame factor (60fps ⇒ ~200ms half-life)
const EPS = 0.3;

let currentOffset = 0;
let targetOffset = 0;
let rafHandle: number | null = null;

function applyTransform() {
  textEl.style.transform = `translateX(${-currentOffset}px)`;
}

function animate() {
  const dx = targetOffset - currentOffset;
  if (Math.abs(dx) < EPS) {
    currentOffset = targetOffset;
    applyTransform();
    rafHandle = null;
    return;
  }
  currentOffset += dx * LERP;
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
