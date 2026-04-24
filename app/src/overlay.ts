import { listen } from "@tauri-apps/api/event";

type State = "idle" | "recording" | "transcribing";

interface StateChangePayload {
  state: State;
  text?: string;
}

const pill = document.getElementById("pill") as HTMLDivElement;
const textEl = document.getElementById("text") as HTMLSpanElement;

const TELETYPE_CHARS = 70;

function render(state: State, text?: string) {
  pill.className = `pill pill--${state}`;
  if (text && text.trim().length > 0) {
    // Teletype/ticker effect: show the tail of the transcript. New words
    // appear on the right, older text scrolls out of view on the left.
    const display =
      text.length > TELETYPE_CHARS
        ? "…" + text.slice(-TELETYPE_CHARS)
        : text;
    textEl.textContent = display;
  } else {
    textEl.textContent =
      state === "recording"
        ? "listening…"
        : state === "transcribing"
        ? "transcribing…"
        : "idle";
  }
}

render("idle");

listen<StateChangePayload>("overlay-state", (e) => {
  render(e.payload.state, e.payload.text);
});
