import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBunWebSocket } from "hono/bun";
import { transcribe, type Style } from "./src/transcribe";
import { auth, requireAuth } from "./src/auth";
import { verifyJwt } from "./src/jwt";
import { StreamSession } from "./src/streamTranscribe";

const { upgradeWebSocket, websocket } = createBunWebSocket();

const app = new Hono();

app.use("/*", cors({ origin: "*" })); // tighten in prod

app.get("/", (c) =>
  c.json({ ok: true, service: "wispr-alt", version: "0.5.2" })
);

app.route("/auth", auth);

const VALID_STYLES = new Set<Style>([
  "clean",
  "business",
  "casual",
  "brief",
  "telegram",
  "email",
  "task",
]);

app.post("/transcribe", requireAuth, async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("audio");
    const language = (form.get("language") as string | null) ?? undefined;
    const postprocess = (form.get("postprocess") as string | null) !== "false";
    const styleRaw = (form.get("style") as string | null) ?? "clean";
    const style: Style = VALID_STYLES.has(styleRaw as Style)
      ? (styleRaw as Style)
      : "clean";

    if (!(file instanceof File)) {
      return c.json({ error: "missing 'audio' file field" }, 400);
    }

    const result = await transcribe({
      audio: file,
      language,
      postprocess,
      style,
    });
    return c.json(result);
  } catch (err) {
    console.error("[/transcribe]", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

/**
 * GET /transcribe-stream — WebSocket upgrade. Auth via ?token=… query
 * param (WS spec doesn't allow custom headers in browsers, so we accept
 * the JWT here). After handshake the server speaks the protocol defined
 * in src/streamTranscribe.ts.
 */
app.get(
  "/transcribe-stream",
  upgradeWebSocket((c) => {
    const token = c.req.query("token") ?? "";
    const payload = verifyJwt(token);
    if (!payload) {
      // We can't reject the upgrade here; close immediately on open.
      return {
        onOpen(_ev, ws) {
          ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
          ws.close(1008, "unauthorized");
        },
      };
    }
    const styleRaw = (c.req.query("style") ?? "clean") as Style;
    const style: Style = VALID_STYLES.has(styleRaw) ? styleRaw : "clean";
    const language = c.req.query("language") ?? "ru";

    let session: StreamSession | null = null;
    return {
      onOpen(_ev, ws) {
        session = new StreamSession(
          {
            send: (data) => ws.send(data as string),
            close: (code, reason) => ws.close(code, reason),
          },
          style,
          language,
        );
        session.start();
      },
      onMessage(ev, _ws) {
        if (!session) return;
        const data = ev.data;
        if (typeof data === "string") {
          session.onControl(data);
        } else if (data instanceof ArrayBuffer) {
          session.onAudioFrame(data);
        } else if (data instanceof Blob) {
          // Browsers and some clients deliver Blob; convert.
          data.arrayBuffer().then((buf) => session?.onAudioFrame(buf));
        }
      },
      onClose() {
        session?.shutdown();
        session = null;
      },
    };
  })
);

const port = Number(process.env.PORT ?? 8787);
console.log(`wispr-alt backend listening on :${port}`);

export default { port, fetch: app.fetch, websocket };
