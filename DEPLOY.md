# wispr-alt — Deploy & package guide

Пошаговая инструкция чтобы **(a)** развернуть backend на Fly.io и **(b)** собрать установщики для macOS и Windows.

---

## 1 · Backend → Fly.io (~5 мин, один раз)

Fly.io — бесплатный tier на старт, scale-to-zero когда нет трафика, ~$0 в месяц для beta.

### 1.1. Установить flyctl

```bash
brew install flyctl     # macOS
# или
curl -L https://fly.io/install.sh | sh
```

### 1.2. Логин / регистрация

```bash
flyctl auth signup      # первый раз
# или
flyctl auth login
```

### 1.3. Создать приложение

```bash
cd ~/Desktop/wispr-alt/backend
flyctl launch --no-deploy --name wispr-alt
```

Если имя `wispr-alt` занято, `flyctl` предложит выбрать другое. В этом случае поправьте `app = "..."` в `backend/fly.toml` и в `app/.env.production` замените `VITE_BACKEND_URL` на свой домен (формат `https://ваше-имя.fly.dev`).

### 1.4. Положить Groq-ключ в секреты

```bash
flyctl secrets set GROQ_API_KEY=gsk_ваш_новый_ключ
```

**Важно:** это ключ, который будет использовать backend в проде. Используйте **новый, отдельный от того, что в `.env`**.

### 1.5. Деплой

```bash
flyctl deploy
```

Через ~2 мин backend будет по `https://wispr-alt.fly.dev`. Проверьте:

```bash
curl https://wispr-alt.fly.dev/
# должно вернуть {"ok":true,"service":"wispr-alt","version":"0.1.0"}
```

### 1.6. Обновления

```bash
cd backend
flyctl deploy          # после правок кода
flyctl logs            # посмотреть логи
flyctl status          # статус машины
```

---

## 2 · macOS .dmg (локальная сборка)

### 2.1. Убедитесь что `app/.env.production` содержит правильный URL

```bash
cat app/.env.production
# VITE_BACKEND_URL=https://wispr-alt.fly.dev
```

Если деплой backend под другим именем — поправьте URL.

### 2.2. Сборка

```bash
cd app
bun run tauri build --target aarch64-apple-darwin
```

Занимает 5–15 мин первый раз, потом кеш ускоряет. Результат:

```
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/wispr-alt_0.1.0_aarch64.dmg
```

### 2.3. Установка (на вашем Mac)

Откройте `.dmg`, перетащите **wispr-alt.app** в Applications. Запустите — macOS скажет "cannot be opened because the developer cannot be verified".

**Обход** (один раз):
- System Settings → Privacy & Security → прокрутите вниз → "wispr-alt.app was blocked" → Open Anyway
- ИЛИ в Finder: правая кнопка на app → Open → Open

После этого macOS попросит **Microphone** и **Accessibility / Automation** permissions — разрешите.

---

## 3 · Windows .msi (через GitHub Actions)

У вас нет Windows машины, поэтому собираем в CI.

### 3.1. Залить репо на GitHub

```bash
cd ~/Desktop/wispr-alt
git remote add origin https://github.com/ваш-юзер/wispr-alt.git
git push -u origin main
```

### 3.2. Прописать secrets в репо

GitHub → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|------|-------|
| `VITE_BACKEND_URL` | `https://wispr-alt.fly.dev` |

### 3.3. Запустить сборку

**Вариант A — по тегу:**
```bash
git tag v0.1.0
git push --tags
```

**Вариант B — вручную:**
GitHub → Actions → `build` workflow → Run workflow

### 3.4. Скачать артефакты

Через 15–25 мин в Actions → run → Artifacts:
- `macos-dmg` — содержит `.dmg` (дубликат того что вы собрали локально)
- `windows-installers` — содержит `.exe` (NSIS) и `.msi`

Разархивируйте, отправьте партнёру `.exe` (рекомендовано — NSIS даёт лучший UX онбординга).

### 3.5. Партнёр устанавливает

Партнёр запускает `.exe` → Windows SmartScreen может показать "Windows protected your PC":
- Кликнуть **More info** → **Run anyway**

Затем стандартный installer. После запуска приложения Windows попросит доступ к микрофону.

---

## 4 · Код-сайнинг (на потом, не блокирует beta)

Текущие установщики **не подписаны** — появятся предупреждения, но работать всё будет.

**Для macOS** (когда купите Apple Developer Program за $99/год):
- Developer ID Application certificate из Xcode
- Переменные `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` в GitHub secrets
- Tauri сам подпишет и нотаризует
- Партнёры не увидят вообще никаких предупреждений

**Для Windows:**
- EV Code Signing cert (~$300–500/год) — мгновенно проходит SmartScreen
- OR Standard Code Signing (~$100/год) — SmartScreen "прогревается" за ~500 скачиваний
- OR Azure Trusted Signing (~$10/мес) — более новый вариант

Пока можно не тратить деньги — предупреждения пугают, но не блокируют.

---

## 5 · Быстрая справка для партнёра (Windows)

Текст, который можно отправить партнёру:

```
Привет. Скачай отсюда [ссылка на wispr-alt-0.1.0_x64-setup.exe].

1. Запусти .exe. Если Windows скажет "Windows protected your PC" —
   кликни "More info" → "Run anyway". Это нормально для непод-
   писанных бета-версий.

2. Пройди installer (просто жми Next).

3. Запусти приложение из Пуска. Разреши микрофон когда попросит.

4. Где угодно (Notepad, Word, Slack, Telegram, браузер) поставь
   курсор в текстовое поле и нажми F5. Начни говорить.

5. Нажми F5 ещё раз — текст появится там, куда ты поставил курсор.

Если глючит — пришли скрин лога из главного окна приложения.
```
