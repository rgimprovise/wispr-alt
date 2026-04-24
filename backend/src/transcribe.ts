/**
 * Groq Whisper → optional Anthropic Haiku postprocess.
 *
 * Env required:
 *   GROQ_API_KEY        — required
 *   ANTHROPIC_API_KEY   — required if postprocess=true
 *
 * Groq reference: https://console.groq.com/docs/speech-text
 * Anthropic docs: https://docs.claude.com/en/api/messages
 */

export interface TranscribeOpts {
  audio: File;
  language?: string; // "ru", "en", or undefined for auto
  postprocess?: boolean;
}

export interface TranscribeResult {
  raw: string;
  clean: string;
  latencyMs: {
    transcribe: number;
    postprocess: number;
    total: number;
  };
}

const GROQ_MODEL = "whisper-large-v3-turbo";
const ANTHROPIC_MODEL = "claude-haiku-4-5";

const POSTPROCESS_SYSTEM = `You clean up raw speech-to-text transcripts.

Rules:
- Remove filler words (um, uh, эээ, ну, вот, как бы, типа) but preserve meaningful hesitations.
- Fix obvious punctuation and capitalization.
- Keep the speaker's voice, vocabulary, and meaning EXACTLY. Do not paraphrase, summarize, or "improve" wording.
- If the transcript is a single sentence, output a single sentence.
- If mixed-language (e.g. Russian with English terms), preserve both as-is.
- Output ONLY the cleaned transcript. No preamble, no explanation, no quotes.`;

export async function transcribe(opts: TranscribeOpts): Promise<TranscribeResult> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error("GROQ_API_KEY is not set");

  const t0 = performance.now();

  // 1. Groq Whisper
  const groqForm = new FormData();
  groqForm.append("file", opts.audio, opts.audio.name || "audio.wav");
  groqForm.append("model", GROQ_MODEL);
  groqForm.append("response_format", "json");
  groqForm.append("temperature", "0");
  if (opts.language) groqForm.append("language", opts.language);

  const groqRes = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: groqForm,
    }
  );

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq ${groqRes.status}: ${errText}`);
  }

  const groqJson = (await groqRes.json()) as { text: string };
  const raw = groqJson.text.trim();
  const t1 = performance.now();

  // 2. Optional Haiku postprocess
  let clean = raw;
  if (opts.postprocess && raw.length > 0) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.warn(
        "postprocess=true but ANTHROPIC_API_KEY not set; skipping"
      );
    } else {
      clean = await cleanWithHaiku(raw, anthropicKey);
    }
  }

  const t2 = performance.now();
  return {
    raw,
    clean,
    latencyMs: {
      transcribe: Math.round(t1 - t0),
      postprocess: Math.round(t2 - t1),
      total: Math.round(t2 - t0),
    },
  };
}

async function cleanWithHaiku(raw: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: POSTPROCESS_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: raw }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = json.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return text || raw;
}
