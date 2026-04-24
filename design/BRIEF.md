# wispr-alt — дизайн-бриф

**Для:** Claude Design (дизайн-система и прототипы UX/UI)
**Ст​атус исходника:** рабочий MVP на macOS (Tauri + TS + Rust), backend на Groq Whisper + Llama-3.3-70B
**Фаза:** готовимся к кросс-платформенному релизу (macOS + Windows, iOS/Android — позже)

---

## 1. Продукт в одном абзаце

Десктопное приложение для голосового ввода текста в любое поле в любом приложении. Пользователь зажимает глобальный хоткей, говорит, и транскрибированный текст автоматически вставляется туда, где стоял курсор. Конкурент — **Wispr Flow**, но наш USP — **готовый подписанный установщик + бесплатный тариф + работа на русском языке из коробки**. Open-source аналоги вроде typr требуют клонировать репо и собирать — мы убираем этот барьер.

## 2. Целевой пользователь

**Primary:**
- Product/engineering/ops specialists, 25–45 лет, печатают много (email, Slack, notion, ide)
- Русско- и/или англоязычные
- Уже попробовали диктовку Apple/Yandex, им не хватает качества или постобработки
- Готовы платить $5–10/мес за сервис, который экономит 30+ минут печати в день

**Secondary:**
- Люди с РДВГ/дислексией — голос быстрее
- Те, кто ведёт длинные заметки, дневники, журналы

## 3. Core value props

1. **Быстро:** хоткей → текст через <2 сек
2. **Live preview:** видишь транскрипт пока говоришь (overlay с бегущей строкой)
3. **Чисто:** LLM-постобработка убирает «эээ», «ну», расставляет пунктуацию
4. **Везде:** вставка в активное приложение (email, Slack, VS Code, браузер, любой текстовый input)
5. **Мультиязык:** автоопределение ru/en, переключение без настроек

## 4. Платформы и константы

| Платформа | Приоритет | Особенности |
|-----------|-----------|-------------|
| **macOS 13+** | v1 | Sequoia-стиль, Liquid Glass, native system fonts |
| **Windows 10/11** | v1 | Fluent-inspired, Segoe UI, WinUI 3 visual cues |
| iOS | v2 | Не в скоупе сейчас, но не заблокировать флоу |
| Android | v2 | То же |
| Linux | — | Не планируется |

**Технический стек:** Tauri 2 → WebView на каждой платформе. Значит **единый дизайн через CSS + platform-specific tokens**. Рендер в WebKit (mac) / WebView2 (win) — оба поддерживают backdrop-filter, transforms, modern CSS.

## 5. Инвентарь поверхностей (что нужно задизайнить)

### 5.1. Floating overlay (главная live-поверхность)

**Когда появляется:** во время записи
**Где:** всегда поверх всего, не отбирает фокус (non-activating window)
**Что показывает:**
- Состояние: idle / recording / transcribing
- **Live-транскрипт** с teletype-бегущей строкой (текст приходит чанками ~2 сек)
- Индикатор микрофона (pulse, VU-метр опционально)

**Размер:** 280–560 × 48–72 px
**Позиция:** по умолчанию — верхний центр или снизу по центру. В дальнейшем — настраиваемая.

**Ключевые состояния:**
- `idle` — скрыт или бледная заглушка
- `recording` — активный (красный/тёплый акцент, пульсация индикатора)
- `transcribing` — после стопа, на доли секунды (жёлтый/нейтральный акцент)
- `error` — красный крест + текст ошибки (сеть, нет микрофона)

**Ограничение:** не должен перекрывать важный UI. Должен быть **некликабельным на фокус** (при клике не должен отбирать фокус у приложения, в которое диктуем).

**Уже сделано:** чёрная pill с эффектом glass, pulsating dot, плавный scroll текста. Нужен редизайн в духе дизайн-системы + Windows-вариант.

### 5.2. Settings window (главное окно)

**Когда появляется:** юзер открыл приложение из трея
**Секции:**
1. **General** — выбор микрофона, hotkey picker, toggle/push-to-talk, язык (auto/ru/en/…), позиция overlay
2. **Account** — email, тариф (Free 30 мин / Pro unlimited), текущее usage, logout
3. **Engine** — BYOK поле (для продвинутых — вставить свой Groq ключ, bypass нашего бэкенда)
4. **About** — версия, автообновления, ссылки

**Размер:** 640 × 480–560 px, нерезайзабельный
**Стиль:** нативный sidebar + content layout, как у mac System Settings / Windows Settings

### 5.3. Tray / menu bar

**macOS:** menu bar icon (SF Symbol `mic.fill`, меняет цвет на красный при записи)
**Windows:** system tray icon (тот же принцип)

**Popup меню:**
- Start/Stop recording (текущий hotkey показан)
- Open Settings
- History (последние 10 транскрипций — для copy-paste на случай если автоинъекция не сработала)
- Quit

### 5.4. Onboarding (первый запуск)

**3–4 экрана:**
1. Welcome — что делает приложение, 10-сек демо-GIF
2. Grant microphone access — большая кнопка, скриншот шага
3. Grant accessibility / automation access — то же, **критично** для macOS, без этого не работает инъекция
4. Sign in — magic link email

### 5.5. History panel

Список последних 50 транскрипций. Каждая запись:
- Timestamp, длительность аудио, preview первых 80 символов
- Клик — копирует в clipboard
- Опционально: кнопка "replay" (если сохранён WAV)
- Right-click — удалить

### 5.6. Error / empty states

- «Нет подключения к интернету» — понятное сообщение, retry
- «Превышена квота (30 мин/мес)» — upgrade CTA или переключение в BYOK
- «Микрофон не найден» — ссылка на настройки
- «Мало речи в записи» — "try again, I didn't hear much"

## 6. Визуальный язык (направление, не предписание)

**Настроение:** professional, быстрый, focused. **НЕ игривый, НЕ неоновый.** Думайте Linear / Raycast / Arc, а не Notion.

**Цветовая гипотеза:**
- Акцент: **тёплый красный** (#EF4444 → #DC2626) для recording-состояния — прямая ассоциация с REC
- Альт-акцент: **янтарный** (#F59E0B) для transcribing/processing
- Нейтрали: **стеклянные серые** с высоким контрастом текста. Dark mode first, light mode parity
- Semantic: success green, warning amber, error red (стандартные оттенки)

**Типографика:**
- **macOS:** SF Pro Text 13–15px для body, SF Pro Display для заголовков
- **Windows:** Segoe UI Variable Text 13–15px
- **Общее fallback:** -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui
- В overlay: моноширинный акцент? (опционально — возможно часть текста "только что распознанный" → моно)

**Surface treatments:**
- Overlay: backdrop-filter blur + saturate, полупрозрачный тёмный. На Windows — fallback на solid + subtle shadow (acrylic поддерживается через WebView2 с оговорками)
- Окна: native look where possible — vibrancy/mica на mac/win соответственно

**Radius:**
- Pill: 9999 (fully rounded)
- Cards/buttons: 8–10px
- Windows: 12px (desktop)

**Motion:**
- Сейчас реализована плавная "трапециевидная" анимация teletype в overlay (rate-limited velocity). Нужно сохранить этот вайб.
- Переходы между состояниями: 180–250ms, easing `cubic-bezier(0.25, 0.46, 0.45, 0.94)` (ease-out quad)
- Pulse для dot: 1.1s infinite

## 7. Компоненты (библиотека, которую нужно нарисовать)

1. **Pill / status indicator** (overlay)
2. **Button** — primary, secondary, ghost; sizes sm/md/lg
3. **Input** — text, email, keyboard-shortcut picker
4. **Select / combobox** — для списка микрофонов, языков
5. **Toggle / switch**
6. **Tabs** (для секций настроек)
7. **Modal / dialog** (для onboarding steps, error confirms)
8. **Menu** (tray popup, right-click menus)
9. **List item** (history, mic selector)
10. **Empty state** (для history когда пусто, для error состояний)
11. **Icon set** — mic, settings, history, account, logout, arrow, dot, check, X

Каждый компонент: default / hover / active / focus / disabled. **Все с keyboard focus rings** (a11y требование).

## 8. Accessibility

- Контраст не ниже WCAG AA (4.5:1 body, 3:1 large)
- Полная навигация с клавиатуры (Tab через всё, Esc закрывает overlay/модалки)
- Поддержка macOS VoiceOver и Windows Narrator
- Пользователь должен иметь возможность работать без мыши
- Размеры шрифтов адаптируются под system font size
- Prefers-reduced-motion отключает pulse и teletype-scroll (становится мгновенной заменой)

## 9. Platform-specific nuances

**macOS:**
- Vibrancy через `window.decorations = false` + CSS backdrop-filter
- Меню бар иконка с template image (monochrome, адаптивна к light/dark)
- Предпочтителен системный acccent color (Pref → General → Accent color)

**Windows:**
- Mica/Acrylic через WebView2 — ограниченная поддержка, fallback на solid
- Заголовок окна с Fluent controls (minimize/maximize/close) встроенный
- Tray иконка с tooltip, стандартные Windows notifications

## 10. Что НЕ нужно проектировать сейчас

- Мобильные версии (iOS/Android) — отложено до v2
- Team features, sharing, collaboration
- Полноценный dashboard с аналитикой
- Marketing website (он делается отдельно, не в app-дизайн-системе)

## 11. Что у нас уже есть (референс)

Текущий MVP: macOS-only, минималистичный. Скриншоты + код лежат в репо:
- `app/overlay.html` / `overlay.ts` / `overlay.css` — текущая pill
- `app/index.html` / `main.ts` / `styles.css` — settings-окно (placeholder)

Текущая цветовая палитра / стиль можно использовать как стартовую точку, но всё открыто к редизайну.

## 12. Deliverables от дизайн-системы

1. Токены (colors, spacing, radius, typography, motion) в виде JSON / CSS variables — для прямого импорта в Tauri приложение
2. Компонентная библиотека в Figma / Pencil с всеми состояниями
3. High-fi макеты всех поверхностей из раздела 5
4. Прототип основного флоу: первый запуск → диктовка в TextEdit/Notepad → success
5. Guideline doc: когда использовать какой компонент, motion principles, a11y
6. Адаптация под macOS и Windows (где нужны различия — явно показано)

---

**Контакты:** этот бриф — отправная точка. После первой итерации мы вернёмся с уточнениями на основе того, что получится в Claude Design.
