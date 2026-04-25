/**
 * OpenAI transcription + GPT cleanup, tuned for Russian.
 *
 * Models:
 *   - gpt-4o-mini-transcribe — newer/faster than whisper-1, supports prompt
 *     priming for domain-specific vocab. ~$0.18/hr. Russian quality is
 *     materially better than Whisper-large-v3 with the right prompt.
 *   - gpt-4o-mini for filler/punctuation cleanup. ~$0.15/M input tokens.
 *
 * Env required:
 *   OPENAI_API_KEY  — required
 *
 * API reference: https://platform.openai.com/docs/api-reference/audio
 */

export interface TranscribeOpts {
  audio: File;
  language?: string; // "ru", "en", etc. Falls back to auto-detect.
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

const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const LLM_MODEL = "gpt-4o-mini";

/**
 * Russian-context priming for the transcriber. Whisper / gpt-4o-transcribe
 * uses this as a soft hint about the domain — improves accuracy on names,
 * mixed-language tokens, и common Russian filler/idioms.
 *
 * Keep short; the model uses it as a stylistic hint, not a hard constraint.
 */
const TRANSCRIBE_PROMPT_RU =
  "Это запись повседневной русской речи: разговоры, диктовка заметок, рабочие сообщения. " +
  "В тексте могут быть имена собственные, технические термины и отдельные английские слова. " +
  "Записывайте речь дословно, включая запинки и паузы — пунктуацию расставьте.";

const POSTPROCESS_SYSTEM = `Вы очищаете сырые транскрипции речи для последующей вставки в текстовое поле.

Правила:
- Удаляйте слова-паразиты ("эээ", "ну", "вот", "как бы", "типа", "э-э", "м-м", "uh", "um"), но сохраняйте осмысленные паузы.
- Расставляйте корректную пунктуацию и заглавные буквы.
- Сохраняйте голос, словарь и смысл говорящего ТОЧНО. Не перефразируйте, не сокращайте, не "улучшайте" формулировки.
- Если транскрипция — одно предложение, выдайте одно предложение.
- При смешении языков (русский с английскими терминами) сохраняйте оба как есть.
- Числа, написанные словами в коротких фразах ("раз два три"), оставляйте словами; в длинных диктовках где явно подразумеваются цифры ("восемь часов вечера") — преобразуйте в цифры.
- Выводите ТОЛЬКО очищенную транскрипцию. Без преамбулы, без объяснений, без кавычек, без префикса "Текст:" и т.п.`;

export async function transcribe(opts: TranscribeOpts): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const t0 = performance.now();

  // 1. Transcribe via OpenAI
  const form = new FormData();
  form.append("file", opts.audio, opts.audio.name || "audio.wav");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  // Russian context prompt by default; if caller specifies English, skip.
  // (Mixed-language audio benefits more from the RU prompt because Whisper
  // already handles English well.)
  if (!opts.language || opts.language.toLowerCase().startsWith("ru")) {
    form.append("prompt", TRANSCRIBE_PROMPT_RU);
  }
  if (opts.language) form.append("language", opts.language);

  const transcribeRes = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    }
  );

  if (!transcribeRes.ok) {
    const errText = await transcribeRes.text();
    throw new Error(`OpenAI transcribe ${transcribeRes.status}: ${errText}`);
  }

  const transcribeJson = (await transcribeRes.json()) as { text: string };
  const raw = transcribeJson.text.trim();
  const t1 = performance.now();

  // 2. Optional GPT cleanup
  let clean = raw;
  if (opts.postprocess && raw.length > 0) {
    clean = await cleanWithGpt(raw, apiKey);
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

async function cleanWithGpt(raw: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        { role: "system", content: POSTPROCESS_SYSTEM },
        { role: "user", content: raw },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI cleanup ${res.status}: ${errText}`);
  }

  const json = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  const text = (json.choices[0]?.message?.content ?? "").trim();
  return text || raw;
}
