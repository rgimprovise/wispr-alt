/**
 * OpenAI transcription + GPT cleanup, tuned for Russian.
 *
 * Models:
 *   - gpt-4o-mini-transcribe — newer/faster than whisper-1, supports prompt
 *     priming for domain-specific vocab.
 *   - gpt-5-nano for cleanup. ~2× faster than gpt-4o-mini, similar quality
 *     for filler removal + light formatting.
 *
 * Env required:
 *   OPENAI_API_KEY  — required
 */

export type Style =
  | "clean" // default — remove fillers, fix punctuation, paragraph breaks
  | "business" // formal email/business tone
  | "casual" // conversational, friendly
  | "brief" // condensed, bullet points / short
  | "telegram" // Telegram-post style: structured, readable
  | "email" // email format with greeting + sign-off
  | "task"; // restructure as todo / action items

export interface TranscribeOpts {
  audio: File;
  language?: string;
  postprocess?: boolean;
  style?: Style;
}

export interface TranscribeResult {
  raw: string;
  clean: string;
  style: Style;
  latencyMs: { transcribe: number; postprocess: number; total: number };
}

const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const LLM_MODEL = "gpt-5-nano";

const TRANSCRIBE_PROMPT_RU =
  "Это запись повседневной русской речи: разговоры, диктовка заметок, рабочие сообщения. " +
  "В тексте могут быть имена собственные, технические термины и отдельные английские слова. " +
  "Записывайте речь дословно, включая запинки и паузы — пунктуацию расставьте.";

/* ───────────────────── Style prompts ───────────────────── */

/**
 * Common rules included in every style. Crucially: instructions about
 * paragraph breaks and line breaks — LLM uses context + natural pauses
 * (already reflected in punctuation) to decide where to start a new
 * paragraph.
 */
const COMMON_RULES = `
Общие правила для ВСЕХ стилей:
- Удаляйте слова-паразиты: «эээ», «ну», «вот», «как бы», «типа», «э-э», «м-м», "uh", "um".
  Сохраняйте осмысленные паузы и заминки только если они несут смысл.
- Расставляйте корректную пунктуацию (запятые, точки, тире, двоеточия) и заглавные буквы.
- Разбивайте текст на абзацы пустой строкой (\\n\\n) при:
   • смене темы или сюжетного блока,
   • переходе к перечислению или списку,
   • явной длинной паузе (видна по словесным маркерам «так», «итак», «значит»,
     «короче», «давайте дальше», смене времени или объекта обсуждения),
   • переходе от размышления к действию / выводу.
- Внутри одного абзаца переносы строк (\\n) ставьте при перечислении пунктов
  (1. ... 2. ... или маркеры ”—” / "•").
- При смешении языков сохраняйте оба как есть.
- Числа: в коротких счётных фразах («раз два три») — словами; в длинных
  диктовках с конкретными цифрами («восемь часов вечера», «двадцать пять
  процентов») — преобразуйте в цифры.
- Выводите ТОЛЬКО результат. Без преамбулы, кавычек, префикса «Текст:».
`.trim();

const STYLE_RULES: Record<Style, string> = {
  clean: `
Стиль: «Чистка» — нейтральный.
- Сохраняйте голос, словарь и смысл говорящего ТОЧНО.
- Не перефразируйте, не сокращайте, не «улучшайте» формулировки.
- Если транскрипция — одно предложение, выдайте одно предложение.
- Если несколько предложений или длинная диктовка — разбейте на абзацы по
  смыслу.
`.trim(),

  business: `
Стиль: «Деловой» — формальная рабочая речь.
- Подчищайте разговорные обороты: «короче» → убрать; «прикольно» → «интересно»;
  «крутой» → «эффективный/удачный».
- Используйте «Вы» с большой буквы при обращении.
- Активный залог, конкретные формулировки. Избегайте громоздких канцеляризмов
  («осуществляется», «является», «производится»).
- Структурируйте: абзацы по темам, маркированные списки при перечислении задач
  или фактов.
- Сохраняйте основной смысл и факты — не выдумывайте новых.
`.trim(),

  casual: `
Стиль: «Неформальный» — разговорный, дружеский тон.
- Можно оставить мягкие разговорные обороты («короче», «слушай», «как раз»),
  убирайте только явный мусор («эээ», «ну вот»).
- «Ты», простая речь, эмоциональные акценты сохраняйте.
- Абзацы по смысловым блокам.
- Если речь идёт сообщением другу — оставляйте человеческий тон,
  не «причесывайте» в формальный.
`.trim(),

  brief: `
Стиль: «Краткий» — сжато, по сути.
- Уберите всю воду: повторы, отступления, разъяснения уже понятного.
- Сохраните только ключевые факты, действия, решения.
- Формат: короткие предложения или маркированные пункты.
- Если в речи перечисление — обязательно списком.
- Если одна мысль — одно предложение, без украшений.
`.trim(),

  telegram: `
Стиль: «Telegram-пост» — структурированный пост для канала.
- Первая строка — крючок (factual, без кликбейта).
- Дальше тело: 2–4 коротких абзаца, каждый — одна мысль.
- Списки оформлять с маркерами «—» или цифрами.
- Без emoji (юзер добавит сам).
- Ссылки/упоминания/имена сохраняйте как есть.
- Конец: либо вывод одной строкой, либо вопрос аудитории.
`.trim(),

  email: `
Стиль: «Email» — структура делового письма.
- Если есть приветствие в начале речи («привет, Иван», «здравствуйте») —
  оформите его как первую строку.
- Тело: 1–3 абзаца с темами, разделёнными пустой строкой.
- Если речь содержит запрос или задачу — выделите её отдельным абзацем.
- В конце: «С уважением, [имя]» только если в речи говоривший назвался.
  Если нет — без подписи.
- Тон деловой, вежливый.
`.trim(),

  task: `
Стиль: «Задача» — структурированный action-item.
- Выделите главную задачу одной строкой в начале (заголовок без точки).
- Затем блоки:
  «Контекст:» — 1–2 предложения зачем это.
  «Что сделать:» — список пунктов с маркером «—».
  «Срок:» — если упоминался.
  «Кому:» — если упоминался ответственный.
- Опускайте блоки которых нет в речи. Не выдумывайте.
- Без вступительных фраз, чисто структура.
`.trim(),
};

/* ───────────────────── Main entry ───────────────────── */

export async function transcribe(opts: TranscribeOpts): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const style: Style = opts.style ?? "clean";

  const t0 = performance.now();

  // 1. Transcribe via OpenAI
  const form = new FormData();
  form.append("file", opts.audio, opts.audio.name || "audio.wav");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
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

  // 2. Cleanup
  let clean = raw;
  if (opts.postprocess && raw.length > 0) {
    if (shouldSkipCleanup(raw)) {
      // Very short utterances ("да", "нет", "ок") don't need a model call.
      // Just normalize whitespace + capitalize first letter.
      clean = quickNormalize(raw);
    } else {
      clean = await cleanWithGpt(raw, apiKey, style);
    }
  }

  const t2 = performance.now();
  return {
    raw,
    clean,
    style,
    latencyMs: {
      transcribe: Math.round(t1 - t0),
      postprocess: Math.round(t2 - t1),
      total: Math.round(t2 - t0),
    },
  };
}

/* ───────────────────── Cleanup helpers ───────────────────── */

/**
 * Whether the text is too short / trivial to bother sending to LLM.
 * Saves ~1-2s round-trip latency on quick "yes/no/ok" dictations.
 */
/**
 * Just the transcription step — no cleanup. Used by the streaming-final
 * handler so it can yield the raw text before kicking off the LLM
 * cleanup stream.
 */
export async function transcribeOnly(
  audio: File,
  language?: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const form = new FormData();
  form.append("file", audio, audio.name || "audio.wav");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (!language || language.toLowerCase().startsWith("ru")) {
    form.append("prompt", TRANSCRIBE_PROMPT_RU);
  }
  if (language) form.append("language", language);
  const res = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form }
  );
  if (!res.ok) {
    throw new Error(`OpenAI transcribe ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { text: string };
  return json.text.trim();
}

/**
 * Public cleanup helper used by both the HTTP /transcribe handler and
 * the streaming proxy. Mirrors the postprocess branch of `transcribe()`.
 */
export async function postprocessText(raw: string, style: Style): Promise<string> {
  if (raw.length === 0) return raw;
  if (shouldSkipCleanup(raw)) return quickNormalize(raw);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  return cleanWithGpt(raw, apiKey, style);
}

function shouldSkipCleanup(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  return false;
}

function quickNormalize(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  if (t.length > 0) t = (t[0]!).toUpperCase() + t.slice(1);
  return t;
}

/**
 * Streaming variant of cleanWithGpt — yields text chunks as the model
 * generates them. Used by the SSE/NDJSON transcribe path so the overlay
 * updates incrementally instead of blocking on the full LLM response.
 */
export async function* cleanWithGptStream(
  raw: string,
  style: Style,
): AsyncGenerator<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const system = `${COMMON_RULES}\n\n${STYLE_RULES[style]}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_completion_tokens: 768,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: raw },
      ],
    }),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI cleanup ${res.status}: ${errText}`);
  }

  // OpenAI's chat/completions stream is SSE: lines like `data: {json}` and
  // `data: [DONE]` separated by blank lines. We split on newlines and parse
  // each JSON, yielding the delta content as we go.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield delta;
      } catch { /* ignore malformed line */ }
    }
  }
}

async function cleanWithGpt(
  raw: string,
  apiKey: string,
  style: Style,
): Promise<string> {
  const system = `${COMMON_RULES}\n\n${STYLE_RULES[style]}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_completion_tokens: 768,
      messages: [
        { role: "system", content: system },
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
