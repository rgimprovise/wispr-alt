# wispr-alt — Deploy & package guide

**Настройка:** backend на вашем VPS за Caddy (автоматический HTTPS), установщики собираются локально (macOS) и через GitHub Actions (Windows).

**Домен:** `alrcvscribe.n8nrgimprovise.space` → `79.132.140.13`

---

## 1 · Backend → ваш VPS (~10 мин, один раз)

### 1.1. Залить код на VPS

Вариант A — через git (удобнее для обновлений):
```bash
ssh user@79.132.140.13
sudo mkdir -p /opt/wispr-alt
sudo chown $USER:$USER /opt/wispr-alt
cd /opt/wispr-alt
git clone https://github.com/ваш-юзер/wispr-alt.git .
# или если репо приватный — через deploy key или scp
```

Вариант B — через scp (быстрее если репо ещё не на GitHub):
```bash
cd ~/Desktop/wispr-alt
rsync -avz --exclude node_modules --exclude .env backend/ user@79.132.140.13:/opt/wispr-alt/backend/
```

### 1.2. Создать `.env` на VPS

```bash
ssh user@79.132.140.13
cd /opt/wispr-alt/backend
cat > .env <<EOF
OPENAI_API_KEY=sk-...
PORT=8787
EOF
chmod 600 .env     # никто кроме владельца не читает
```

**Важно:** выпустите **отдельный** Groq ключ специально для прод-бэкенда. Старый из dev не используйте — он мог протечь в логи.

### 1.3. Запустить через docker-compose

```bash
cd /opt/wispr-alt/backend
docker compose up -d --build
docker compose logs -f           # проверить что поднялось

# Проверка с того же VPS:
curl http://localhost:8787/
# {"ok":true,"service":"wispr-alt","version":"0.1.0"}
```

### 1.4. Подключить Caddy (HTTPS)

Открыть `/etc/caddy/Caddyfile`, добавить блок из `/opt/wispr-alt/backend/Caddyfile.snippet`, либо просто:

```bash
sudo cat /opt/wispr-alt/backend/Caddyfile.snippet >> /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f      # посмотреть как Caddy выпустит TLS cert
```

Caddy сам получит Let's Encrypt сертификат на первом запросе (может занять 10–30 сек).

### 1.5. Проверка снаружи

С любой машины:
```bash
curl https://alrcvscribe.n8nrgimprovise.space/
# {"ok":true,"service":"wispr-alt","version":"0.1.0"}
```

Если 502 — backend контейнер не поднят. Если SSL-ошибка — Caddy ещё не получил cert, подождите минуту.

### 1.6. Обновления backend в будущем

```bash
ssh user@79.132.140.13
cd /opt/wispr-alt
git pull
cd backend
docker compose up -d --build
```

Для смены Groq-ключа:
```bash
# правите .env
docker compose restart
```

---

## 2 · macOS .dmg

### 2.1. Уже собран с правильным URL

После последней сборки .dmg смотрит на `https://alrcvscribe.n8nrgimprovise.space`:
```
~/Desktop/wispr-alt_0.1.0_x64.dmg
```

Если меняете домен — пересоберите:
```bash
cd ~/Desktop/wispr-alt/app
bun run tauri build --target x86_64-apple-darwin
```

Результат:
```
src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/wispr-alt_0.1.0_x64.dmg
```

### 2.2. Установка на вашем Mac

1. Откройте `.dmg`, перетащите **wispr-alt.app** в Applications
2. Запустите — macOS скажет "cannot be opened because the developer cannot be verified"
3. **Обход** (один раз):
   - System Settings → Privacy & Security → прокрутите вниз → "wispr-alt.app was blocked" → **Open Anyway**
   - ИЛИ в Finder: правая кнопка на app → Open → Open Anyway
4. Разрешите **Microphone** когда попросит
5. При первом F5 → запись → stop: попросит **Automation** для System Events — разрешите

### 2.3. Тестирование

- Откройте TextEdit, кликните в документ
- Нажмите **F5** в любом приложении — pill выплывет сверху
- Говорите — текст появляется в pill с задержкой ~1–2 сек
- Нажмите F5 — pill спрячется, текст вставится в TextEdit

---

## 3 · Windows .msi — через GitHub Actions

У вас нет Windows машины, поэтому собираем в CI.

### 3.1. Залить репо на GitHub (если ещё не)

```bash
cd ~/Desktop/wispr-alt
git remote add origin git@github.com:ваш-юзер/wispr-alt.git
git push -u origin main
```

### 3.2. Прописать secrets

GitHub → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|------|-------|
| `VITE_BACKEND_URL` | `https://alrcvscribe.n8nrgimprovise.space` |

### 3.3. Запустить сборку

**Вариант A — по тегу:**
```bash
git tag v0.1.0
git push --tags
```

**Вариант B — вручную:**
GitHub → Actions → `build` workflow → Run workflow

Сборка займёт 15–25 мин.

### 3.4. Скачать и отдать партнёру

GitHub → Actions → запустившийся run → Artifacts:
- `windows-installers` — архив с `.exe` (NSIS installer, предпочтительнее) и `.msi` (MSI)

Распакуйте, отправьте `.exe` партнёру.

---

## 4 · Партнёр устанавливает (Windows)

Текст для отправки:

> Привет. Скачай отсюда [ссылка].
>
> 1. Запусти `.exe`. Если Windows покажет "Windows protected your PC" — кликни **More info** → **Run anyway**. Это потому что приложение пока без официальной подписи (beta).
>
> 2. Пройди installer, всё по умолчанию.
>
> 3. Запусти wispr-alt из меню Пуск. Разреши доступ к микрофону.
>
> 4. Где угодно (Notepad, Word, Slack, Telegram) поставь курсор в текстовое поле и нажми **F5**. Начни говорить.
>
> 5. Нажми **F5** ещё раз — текст вставится туда, где курсор.
>
> Если что-то не работает — пришли скриншот главного окна приложения (там лог внутри).

---

## 5 · Troubleshooting

| Симптом | Причина | Фикс |
|---------|---------|------|
| macOS: "app is damaged" | ad-hoc подпись не распознана | System Settings → Privacy & Security → Open Anyway (первый раз) |
| macOS: F5 не реагирует после установки | глобальный хоткей требует Accessibility | System Settings → Privacy & Security → Accessibility → добавить wispr-alt, перезапустить |
| macOS: текст копируется в буфер, но не вставляется | System Events не имеет Automation permission | System Settings → Privacy & Security → Automation → wispr-alt → System Events включить |
| Приложение говорит "failed to fetch" в логе | backend недоступен или CORS / SSL | `curl https://alrcvscribe.n8nrgimprovise.space/` с любой машины |
| Fly.io ничего не знаю про это | мы ушли с Fly.io | игнорировать, ничего не надо |
| Backend контейнер всё время рестартует | проблема с .env или Docker | `docker compose logs` на VPS |

---

## 6 · Код-сайнинг (когда купите — в будущем)

Пока unsigned — работает, но пугает предупреждениями.

**macOS:** Apple Developer Program ($99/год) → сертификат "Developer ID Application" в Xcode → добавить в GitHub secrets `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` → Tauri build сам подпишет + нотаризует. Партнёры не увидят никаких предупреждений.

**Windows:** Azure Trusted Signing (~$10/мес) — самый дешёвый и новый способ. Или Standard Code Signing cert (~$100/год). EV cert дороже (~$300+) но мгновенно проходит SmartScreen.

Ни то ни другое не блокирует beta — пока работаем без подписи.
