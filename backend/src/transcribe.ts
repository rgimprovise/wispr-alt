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

ЧИСТКА:
- Удаляйте слова-паразиты: «эээ», «ну», «вот», «как бы», «типа», «э-э», «м-м», «short», "uh", "um".
- Удаляйте повторы и оговорки: «я хотел... я хотел сказать» → «я хотел сказать».
- Сохраняйте смысл и интонацию говорящего точно.

ПУНКТУАЦИЯ И РЕГИСТР:
- Расставляйте запятые, точки, тире, двоеточия, вопросительные/восклицательные знаки.
- Первая буква предложения и имена собственные — с заглавной.

АБЗАЦЫ — ОБЯЗАТЕЛЬНО для текстов длиннее 3 предложений:
Между абзацами ВСЕГДА ставьте пустую строку (\\n\\n). Новый абзац начинайте при:
- смене темы / переходе к новому объекту обсуждения;
- словах-маркерах перехода: «так», «итак», «короче», «значит», «давайте дальше»,
  «теперь», «кстати», «во-первых / во-вторых», «с одной / с другой стороны»,
  «и наконец», «в итоге»;
- переходе от описания к действию или выводу;
- начале перечисления / списка.

Пример (НЕправильно — единый поток):
"Сегодня закончил отчёт по продажам цифры за квартал хорошие выросли на 15 процентов теперь надо готовить презентацию для совета директоров встреча в четверг."

Пример (ПРАВИЛЬНО — два абзаца по смыслу):
"Сегодня закончил отчёт по продажам. Цифры за квартал хорошие — выросли на 15 процентов.

Теперь надо готовить презентацию для совета директоров. Встреча в четверг."

ВНУТРИ АБЗАЦА — переносы строк (\\n) только для маркированных списков:
- список с маркером «—» или «•» или цифрой,
- каждый пункт — отдельная строка.

ЯЗЫК И ЧИСЛА:
- Смешение языков сохраняйте как есть.
- Короткие счётные фразы («раз два три») — словами; конкретные числа
  («восемь часов», «25 процентов», «1500 рублей») — цифрами.

ВЫВОД:
- Только результат. Без префиксов «Текст:», без кавычек вокруг ответа,
  без объяснений своих действий.
`.trim();

const STYLE_RULES: Record<Style, string> = {
  clean: `
Стиль: «Чистка» — минимальное вмешательство.
ЦЕЛЬ: точная транскрипция с пунктуацией и абзацами. Голос автора — нетронут.
- Сохраняйте словарь и интонацию говорящего БЕЗ изменений.
- НЕ перефразируйте, не «улучшайте» обороты, не подбирайте синонимы.
- Только: убрать мусор, расставить пунктуацию, разбить на абзацы.
- Если речь рваная и эмоциональная — оставьте такой.
`.trim(),

  business: `
Стиль: «Деловой» — формальный рабочий тон.
ЦЕЛЬ: переписать речь как письменное сообщение коллеге/руководителю.
АКТИВНО ПЕРЕФОРМУЛИРУЙТЕ:
- Разговорное → формальное:
  «короче» → удалить; «прикольно» → «интересно»; «крутой» → «удачный»;
  «забил» → «отложил»; «нифига» → «ничего»; «тупо» → «просто»;
  «надо/нужно» → «требуется/предстоит» (в зависимости от контекста).
- «Ты» → «Вы» (с заглавной при прямом обращении).
- Активный залог, конкретные формулировки, без воды.
- Структура: абзацы по темам, маркированные списки для задач/фактов.

Пример входа:
"короче я тут глянул отчет за прошлый квартал там цифры реально просели надо будет с финансами созвониться разобраться откуда такая дыра"

Пример выхода:
"Я ознакомился с отчётом за прошлый квартал — показатели заметно снизились.

Предлагаю созвониться с финансовым отделом и разобраться в причинах расхождения."
`.trim(),

  casual: `
Стиль: «Неформальный» — живой разговорный тон.
ЦЕЛЬ: личное сообщение другу/коллеге, как живая речь, но читаемая.
- Сохраняйте «ты», эмоции, разговорные обороты («короче», «слушай», «прикольно»).
- Убирайте только явный мусор: «эээ», «ну», «как бы», «типа».
- Никаких канцеляризмов и формального тона.
- Можно сокращать «привет, как дела» в начале, оставлять восклицания.

Пример входа:
"эээ слушай ну я короче глянул вчера тот сериал про который ты говорил типа ну в целом норм но первая серия как-то затянутая прям"

Пример выхода:
"Слушай, я короче глянул вчера тот сериал, про который ты говорил. В целом норм, но первая серия как-то затянутая прям."
`.trim(),

  brief: `
Стиль: «Краткий» — выжимка фактов.
ЦЕЛЬ: сократить речь в 2-3 раза, оставив только суть.
- Убирайте: повторы, отступления, объяснения очевидного, эмоции, оговорки.
- Сохраняйте: имена, числа, даты, действия, решения, ключевые выводы.
- Формат: маркированный список «—», если в речи несколько фактов;
  одно короткое предложение, если одна мысль.
- БЕЗ вводных «итак», «короче говоря», «таким образом».

Пример входа (78 слов):
"Так, значит мы тут вчера обсудили с командой план на следующий месяц и в принципе пришли к выводу что нам нужно сосредоточиться на трёх вещах: во-первых это, конечно же, доделать функционал авторизации до конца, второе это вот разобраться с багами на айфоне которые накопились, и третье - запустить уже наконец маркетинговую кампанию которую мы откладываем уже два месяца"

Пример выхода (24 слова):
"План на месяц:
— доделать авторизацию,
— исправить накопившиеся баги на iOS,
— запустить маркетинговую кампанию."
`.trim(),

  telegram: `
Стиль: «Telegram-пост» — пост для канала или чата.
ЦЕЛЬ: структурированный текст с крючком и читаемыми абзацами.
- Первая строка — суть в 1 предложении (БЕЗ кликбейта, БЕЗ эмодзи).
- Далее 2-4 коротких абзаца, каждый = одна мысль, разделены \\n\\n.
- Списки — с маркером «—» или цифрами, по строке на пункт.
- Имена/ссылки/упоминания сохраняйте как есть.
- В конце — вывод одной строкой, либо вопрос аудитории, либо опускайте.
- НИКАКИХ эмодзи, преамбул, обращений «друзья!» / «коллеги!».

Пример выхода:
"Запустили новую фичу — автодополнение в редакторе.

Идея простая: пока пишешь, модель предлагает следующие 2-3 слова на основе контекста. Жмёшь Tab, чтобы принять.

Пока работает только для русского. На английский раскатим в следующем спринте.

Что думаете — попробуете?"
`.trim(),

  email: `
Стиль: «Email» — деловое письмо.
ЦЕЛЬ: оформить речь как письменное сообщение с приветствием и подписью.
СТРУКТУРА:
1. Приветствие: «Здравствуйте, [имя]» если адресат назван, иначе «Здравствуйте».
2. Пустая строка.
3. Тело — 1-3 абзаца, разделены \\n\\n. Один абзац = одна тема.
4. Если есть запрос/задача — выделите отдельным абзацем.
5. Подпись: «С уважением, [имя]» только если автор назвал себя в речи,
   иначе НЕ выдумывайте — просто опускайте подпись.
- Тон: вежливый, без панибратства и без канцелярщины.

Пример входа:
"иван привет смотри я тут посмотрел договор на странице 3 пункт 5 какая-то странная формулировка про сроки давай созвонимся обсудим у меня сегодня после 4 свободно"

Пример выхода:
"Здравствуйте, Иван.

Посмотрел договор. На странице 3, пункт 5 — неоднозначная формулировка про сроки.

Предлагаю созвониться, чтобы обсудить. Сегодня после 16:00 я свободен."
`.trim(),

  task: `
Стиль: «Задача» — структурированный action-item для трекера.
ЦЕЛЬ: жёсткая структура, как карточка в Jira / Linear / Notion.
ФОРМАТ (опускайте блоки которых нет в речи):

[Заголовок задачи одной строкой, без точки]

Контекст:
[1-2 предложения — зачем это и что предшествовало]

Что сделать:
— [пункт 1]
— [пункт 2]
— [пункт 3]

Срок: [если упомянут]
Ответственный: [если упомянут]

ПРАВИЛА:
- Заголовок начинается с глагола в инфинитиве: «Обновить...», «Исправить...».
- Не выдумывайте срок/ответственного, если не названы — пропустите блок.
- НИКАКИХ преамбул «Так, значит у нас задача...».
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
