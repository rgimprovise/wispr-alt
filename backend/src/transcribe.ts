/**
 * Groq Whisper → optional Groq Llama postprocess (single vendor).
 *
 * Env required:
 *   GROQ_API_KEY  — required
 *
 * Groq reference: https://console.groq.com/docs
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

const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";
const GROQ_LLM_MODEL = "llama-3.3-70b-versatile";

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
  groqForm.append("model", GROQ_WHISPER_MODEL);
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

  // 2. Optional LLM postprocess (same Groq key)
  let clean = raw;
  if (opts.postprocess && raw.length > 0) {
    clean = await cleanWithLlama(raw, groqKey);
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

async function cleanWithLlama(raw: string, apiKey: string): Promise<string> {
  const res = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_LLM_MODEL,
        temperature: 0.1,
        max_tokens: 1024,
        messages: [
          { role: "system", content: POSTPROCESS_SYSTEM },
          { role: "user", content: raw },
        ],
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq LLM ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  const text = (json.choices[0]?.message?.content ?? "").trim();
  return text || raw;
}
