# Стабильный keystore для Android-сборок

Чтобы Android-приложение можно было обновлять in-place (без удаления старой версии), все APK должны быть подписаны **одним и тем же ключом**. Раньше каждый CI-билд генерировал новый случайный debug-ключ — отсюда «приложение не установлено» при попытке обновить.

Один раз генерируете keystore локально, добавляете в GitHub Secrets — все будущие билды подписываются им автоматически.

## 1. Сгенерировать keystore (один раз)

```bash
cd ~/Desktop/wispr-alt/android
keytool -genkey -v \
  -keystore wispr-alt.keystore \
  -alias wispr \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storetype PKCS12
```

Спросит:
- **Keystore password** — придумайте надёжный (например 16-символьный из менеджера паролей). **Запишите его** — потеря = невозможность подписывать новые версии тем же ключом
- **Key password** — можете использовать тот же что и keystore password (Android рекомендует одинаковые)
- **Имя/организация/город/код страны** — заполните чем-нибудь осмысленным, не критично для self-distribution

Файл `wispr-alt.keystore` создастся в `android/`. **Этот файл — секрет**, в репо его не коммитим (в `.gitignore` он уже добавлен).

## 2. Положить в GitHub Secrets

```bash
# Закодировать keystore в base64 для хранения в Secrets
base64 -i wispr-alt.keystore | pbcopy
# (теперь содержимое в буфере обмена)
```

Зайдите на https://github.com/rgimprovise/wispr-alt/settings/secrets/actions → **New repository secret** → создайте 4 secret:

| Name | Value |
|------|-------|
| `ANDROID_KEYSTORE_BASE64` | вставить из буфера |
| `ANDROID_KEYSTORE_PASSWORD` | пароль keystore |
| `ANDROID_KEY_ALIAS` | `wispr` (или что вы указали в `-alias`) |
| `ANDROID_KEY_PASSWORD` | пароль key (обычно совпадает с keystore password) |

## 3. Сборка локально (опционально)

Если хотите подписывать билды и локально:

```bash
# в android/local.properties (НЕ коммитится)
keystorePath=/Users/your/path/wispr-alt/android/wispr-alt.keystore
keystorePassword=ваш_пароль
keyAlias=wispr
keyPassword=ваш_пароль_key
```

Без этого файла gradle подпишет дефолтным debug-ключом (для тестов на одном устройстве — норм, для распространения — нет).

## 4. Триггер CI

```bash
git tag android-v0.3.2          # инкремент любого числа
git push --tags
```

Через ~10 мин в Actions появится artifact `android-apk` с **двумя** APK:
- `app-release.apk` — основной, оптимизированный, подписанный — отдавайте партнёрам
- `app-debug.apk` — для отладки

Любой будущий билд (новая версия) подписан тем же ключом → Android позволит установить **поверх** старой без удаления.

## ⚠️ Важно

- **Не теряйте keystore.** Если потеряете — никогда не сможете обновить установленные APK тем же ключом. Юзеры будут вынуждены удалять и ставить заново. Бэкап в защищённом месте (1Password / Bitwarden / зашифрованный диск)
- **Не коммитьте keystore в git.** Уже в `.gitignore`, но проверьте перед `git add -A`
- **Пароли тоже не теряйте.** Без них keystore бесполезен
- При смене keystore (если так случится) — все юзеры должны будут переустановить приложение с нуля
