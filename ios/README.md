# wispr-alt iOS keyboard

Кастомная iOS-клавиатура с кнопкой диктовки. Архитектура:

- **Main app** (SwiftUI) — onboarding + recording UI с полноценным доступом к микрофону
- **Keyboard extension** (UIKit) — QWERTY/ЙЦУКЕН клавиатура с кнопкой 🎤
- **App Group** для обмена транскриптом между расширением и основным приложением

## UX flow

1. Юзер тапает в текстовое поле в любом приложении (Notes, Telegram, etc.)
2. Свайпом по globe-кнопке на стандартной клавиатуре переключается на wispr-alt
3. Тапает 🎤 → wispr-alt keyboard открывает основное приложение (deep link `wispralt://dictate`)
4. Основное приложение записывает голос → отправляет на backend → показывает текст
5. Юзер тапает «Передать в клавиатуру» → текст сохраняется в общем App Group
6. Свайпом снизу или Cmd+Tab возвращается в исходное приложение
7. Клавиатура wispr-alt при появлении видит pending-транскрипт → автоматически вставляет в поле

## Установка (один раз)

### Требования

- macOS с Xcode 15+
- iPhone с iOS 16+, подключённый по USB или Wi-Fi (требуется Developer Mode на iPhone: Settings → Privacy & Security → Developer Mode → On)
- Apple ID (бесплатный — для подписи; платный Developer Program не нужен для self-install)

### Подготовка проекта

```bash
brew install xcodegen
cd ios
xcodegen generate
open wispr-alt.xcodeproj
```

### Настройка Signing & Capabilities в Xcode

В Xcode выполните для **обоих** target-ов (`wispr-alt` И `wispr-alt-keyboard`):

1. Выберите target → вкладка **Signing & Capabilities**
2. **Team:** выберите ваш Apple ID (войдите если нужно: Xcode → Settings → Accounts)
3. Bundle Identifier должен быть уникальным — Xcode подскажет если конфликт. Можете изменить префикс на свой обратный домен, например `com.вашлогин.wispralt`. Не забудьте также поменять в keyboard-target → `com.вашлогин.wispralt.keyboard`
4. Нажмите **+ Capability** → **App Groups**
5. Нажмите `+` под списком App Groups → создайте группу `group.com.вашлогин.wispralt` (то же имя должно быть включено в обоих target'ах)
6. Откройте файлы `wispr-alt/SharedStorage.swift` и `wispr-alt-keyboard/SharedStorage.swift` и поменяйте константу `appGroup` на тот же ID что в Xcode

### Сборка и установка

1. Подключите iPhone, выберите его в верхней панели Xcode (вместо Simulator)
2. Нажмите ▶ (Cmd+R)
3. Xcode попросит на iPhone доверять разработчику: Settings → General → VPN & Device Management → ваш Apple ID → Trust
4. Приложение запустится на iPhone

### На iPhone

1. Откройте `wispr-alt` из меню → пройдите 3 шага onboarding:
   - Разрешить микрофон (нативный диалог)
   - Settings → General → Keyboard → Keyboards → Add New Keyboard… → wispr-alt
   - В этом же экране тапните по wispr-alt → включите тоггл **Allow Full Access** (нужен для сетевых запросов)

### Использование

1. Откройте Notes (или любое приложение с текстовым полем)
2. Тапните в текстовое поле — появится клавиатура
3. Удерживайте 🌐 (globe) на стандартной клавиатуре → выберите wispr-alt
4. Тапните **🎤** → wispr-alt-приложение откроется
5. Скажите «тестовая фраза» → нажмите Готово → нажмите «Передать в клавиатуру»
6. Свайпните вверх снизу экрана для возврата в Notes
7. Текст автоматически вставится в поле

## Ограничение для бесплатного Apple ID

- Free-tier signing → собранное приложение **работает 7 дней**, потом перестанет
- Чтобы продлить — пересобрать через Xcode и переустановить
- Установить на чужой iPhone (партнёру) **невозможно** без Apple Developer Program ($99/год + TestFlight)

## Известные проблемы MVP

- Нет автокоррекции, emoji, эмодзи-клавиатуры, цифровой раскладки 123
- Цифры можно ввести через стандартную клавиатуру (globe → стандартная)
- Backend URL зашит, нельзя поменять из UI
- Дизайн минималистичный — упор на функциональность
- **iOS не позволяет программно вернуться в исходное приложение**, поэтому юзеру нужно вручную свайпнуть вверх. Это ограничение iOS, не наш баг

## Архитектурные решения

- **Запись в основном приложении, не в keyboard extension:** Apple ограничивает аудиозапись из keyboard extensions, и приложения с такой архитектурой регулярно реджектят в App Store. Поэтому keyboard только триггерит deep link, а запись происходит в полноценном приложении
- **Передача транскрипта через App Group UserDefaults:** легковесно, без сложной IPC, синхронно
- **Polling в `viewWillAppear`:** keyboard проверяет shared storage каждый раз когда становится видимой → если есть pending → вставляет
