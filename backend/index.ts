import { Hono } from "hono";
import { cors } from "hono/cors";
import { transcribe, type Style } from "./src/transcribe";

const app = new Hono();

app.use("/*", cors({ origin: "*" })); // tighten in prod

app.get("/", (c) =>
  c.json({ ok: true, service: "wispr-alt", version: "0.2.0" })
);

const VALID_STYLES = new Set<Style>([
  "clean",
  "business",
  "casual",
  "brief",
  "telegram",
  "email",
  "task",
]);

app.post("/transcribe", async (c) => {
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

const port = Number(process.env.PORT ?? 8787);
console.log(`wispr-alt backend listening on :${port}`);

export default { port, fetch: app.fetch };
