# А-ГОЛОС / AGOLOS — brand system

Single source of truth for v2 production branding. All design tokens
(colors, typography, radii, shadows) referenced from platform stylesheets
should match this file. When updating brand: change here first, then
mirror into:

- `app/src/tokens.css` (Tauri / desktop UI)
- `android/app/src/main/res/values/colors.xml` + `values-night/colors.xml`
- `ios/wispr-alt/AgolosTokens.swift`

## Identity

- **Name (Russian, primary):** «А-ГОЛОС» (with hyphen, formal). Read as «А плюс ГОЛОС».
- **Compact / app-name:** «АГОЛОС» (no hyphen — for app icons, file names, single-line UI).
- **Latin transliteration:** AGOLOS (used in bundle IDs, file paths, filenames where Cyrillic is impractical).
- **Tagline:** «Скажите мысль. Получите текст.»
- **Verbal subtitle:** «Голос, структура, влияние.»
- **Category:** Голосовой интерфейс для работы с текстом. Не «диктофон», не «расшифровка аудио».

## Brand platform

| | |
|---|---|
| **Категория** | Голосовой интерфейс для работы с вкладками, ссылками и цифровой структурой |
| **Обещание** | Быстрый доступ к нужному. Меньше хаоса, больше контроля |
| **Для кого** | Предприниматели, менеджеры, команды, digital-специалисты |
| **Характер** | Точный, технологичный, собранный, уверенный |
| **Позиционирующий слоган** | АГОЛОС помогает упорядочивать цифровое пространство |

## Logo construction (3 variants)

Per guidebook slide 03:

1. **Знак** (mark only) — угловая красная буква «А» на тёмном фоне. Файл: `brand/logo/svg/letter-a.svg`. Используется в местах, где места мало или должен быть только узнаваемый символ: app icon, favicon, status bar, watermark.
2. **Знак + слово** (full lockup, color) — красная «А» + белое «ГОЛОС». Файлы: `brand/logo/svg/lockup-horizontal.svg` (один уровень), `lockup-vertical.svg` (А над ГОЛОС). Используется в шапках экранов, презентациях, лендингах.
3. **Монохром** — вся композиция в одном цвете (мягкий белый на тёмном, или белый на красном). Файл: `brand/logo/svg/lockup-mono-horizontal.svg`. Используется в одноцветной печати, на красном фоне, в watermark-сценариях.

### Конструкция

- **Основа:** угловая буква «А», вытянутая, с диагональным внутренним cut'ом и трёхмерным изломом для крупных декоративных применений (hero PNG). Для малых размеров — flat-вектор без 3D.
- **Смысл:** голос, импульс, движение.
- **Характер:** острый, современный, энергичный.

### Охранное поле

Минимальное расстояние до края макета или до соседних элементов = ширине знака «А». В композиции lockup-horizontal — ширина буквы «А» с каждой стороны от полной композиции.

### Минимальный размер

- В вариантах **знак** и **lockup**: **24 px** по большей стороне. На меньших размерах детали диагонального cut'а теряются — используйте упрощённый flat-вектор.
- App icon на iOS / Android / desktop: рендер из `brand/logo/svg/app-icon.svg` (включает в себя padding на угловые маски OS).

### Запреты

- Не искажать пропорции знака.
- Не делать знак округлым / мягким.
- Не добавлять случайные эффекты, тени, glow внутри знака (внешний glow на фоне макета — допустимо).
- Не использовать на фоне, где красный «А» теряет контраст (например на тёплом красном) — переключайтесь на монохром.

## Color palette

All hex values lifted directly from `BrandingAGOLOS.docx`.

| Token | Hex | Usage |
|---|---|---|
| `bg-base` (charcoal black) | `#0B0D16` | Main app background, deepest dark blocks, interface base |
| `bg-elevated` (deep graphite) | `#161A24` | Cards, panels, secondary backgrounds, UI containers |
| `bg-night-blue` | `#11182B` | Complex dark gradients, premium tech mood backgrounds |
| `accent-red` (signal red) | `#F22A37` | **Main brand accent.** Logo, CTA buttons, active states, key lines, icons, highlights |
| `accent-red-deep` | `#B90F1C` | Shadows, gradients, hover states, secondary red accents |
| `text-primary` (soft white) | `#F5F6F8` | Main text on dark, large headings, key labels |
| `text-secondary` (UI grey) | `#8A90A2` | Captions, secondary text, disabled states, helper labels |
| `glow-burgundy` | `#3A0D14` | Background glow zones, red darkening, soft transitions |

### Signature gradient

```
linear-gradient(135deg, #0B0D16 0%, #11182B 40%, #3A0D14 80%, #B90F1C 100%)
```

Soft red glow lives in the **top-left** quadrant of large surfaces, OR
in the active-action zone (around the record button when recording).

## Typography

### Display / headings — `Inter Display`

Bundled at `brand/fonts/inter/{ttf,woff2}/`. Open Font License — free for
commercial use. Replaces "Druk Wide" from the original brand doc (which
is paid commercial); InterDisplay-Black is listed in the same brand doc
as an explicit alternative.

- **H1 (hero / app title):** InterDisplay Black, 36–48 px, letter-spacing −0.02em
- **H2 (section):** InterDisplay ExtraBold, 22–28 px
- **H3 (card title):** InterDisplay Bold, 16–18 px

### UI / body — `Inter`

- **Body:** Inter Regular, 14–15 px, line-height 1.5
- **UI label:** Inter Medium, 13 px
- **Caption / hint:** Inter Regular, 12 px, color `text-secondary`
- **Code / mono:** system mono fallback (`ui-monospace, Menlo`)

### Logo lockup — `RodchenkoC SHA`

`brand/fonts/RodchenkoC-SHA.otf` — supplied by the founder. Used **only**
to render «АГОЛОС» wordmark when the PNG/SVG logo can't be used (small
icon overlays, dynamic UI elements). Never use Rodchenko for body or UI.

## Radii / shape

- Cards / panels: **20 px**
- Buttons / inputs: **14 px**
- Pills / badges: **999 px** (full)
- Logo container: **24 px** with internal logo padding `~12%`

## Elevation / shadows

```
shadow-sm: 0 1px 0 rgba(0,0,0,.4) inset, 0 2px 8px rgba(0,0,0,.3)
shadow-md: 0 4px 16px rgba(0,0,0,.4)
shadow-glow: 0 0 24px rgba(242, 42, 55, 0.25)   // red CTA glow
```

## Voice — copywriting rules

Confident, short, technological, calm. **No** marketing exclamations,
**no** "revolutionary" claims, **no** AI-jargon dump.

### Approved brand phrases
- «Голос, структура, влияние.»
- «Скажите мысль. Получите текст.»
- «Голос превращается в рабочий текст.»
- «Меньше хаоса. Больше контроля.»
- «Текст появляется там, где вы работаете.»
- «Управляйте текстом голосом.»
- «А-ГОЛОС помогает быстро фиксировать и структурировать мысли.»

### UI string examples (replace v1 paper-tone copy with these)

| Surface | v1 (Беловик) | v2 (А-ГОЛОС) |
|---|---|---|
| Tagline (main window) | «Голосовой интерфейс для работы с текстом» | «Скажите мысль. Получите текст.» |
| Idle status | «готов» | «готов слушать» |
| Recording status | «recording» | «слушаю» |
| Transcribing status | «transcribing» | «структурирую» |
| Login prompt | «Введите email — продолжим в зависимости от того, есть ли у вас пароль.» | «Email для входа. Продолжим за один шаг.» |
| Hotkey hint | «Нажмите F5 в любом приложении для записи.» | «`F5` — запись в любом приложении.» |
| Set-password banner | «Установите пароль / В следующий раз войдёте без кода из почты.» | «Пароль — для быстрого входа без писем.» |
| Empty/no-permission state | «Без этого разрешения кнопка-микрофон не появится…» | «Включите разрешение, чтобы продолжить.» |

## Don'ts (from brand doc)

- No bright random colors, no acid gradients, no cartoon illustrations,
  no excessive gloss, no overdone 3D, no friendly soft tone, no banner-
  style ads, no old-corporate PowerPoint typography, no game-platform
  aesthetics.
- No emojis in product chrome (status, errors, hints). Emojis OK only
  if they appear in user dictation content.

## Logo files

`brand/logo/`:
- `agolos-vertical.png` — primary lockup, А above ГОЛОС, square format
- `agolos-horizontal.png` — wide single-line lockup for app bars and headers

When SVG versions become available, replace these with vector originals.
