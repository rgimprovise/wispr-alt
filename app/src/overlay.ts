import { listen } from "@tauri-apps/api/event";

type State = "idle" | "recording" | "transcribing";

interface StateChangePayload {
  state: State;
  text?: string;
}

const pill = document.getElementById("pill") as HTMLDivElement;
const textEl = document.getElementById("text") as HTMLSpanElement;

function render(state: State, text?: string) {
  pill.className = `pill pill--${state}`;
  if (text && text.trim().length > 0) {
    textEl.textContent = text;
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
