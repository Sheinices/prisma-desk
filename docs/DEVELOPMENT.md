# Руководство разработчика

Инструкции для пользователей находятся в [README](../README.md).
Приложение использует Tauri 2, Rust и JavaScript; интерфейс Prisma
загружается с выбранного пользователем зеркала.

## Подготовка

Нужны Node.js 20+, npm, Rust с Cargo и системные зависимости Tauri
для выбранной платформы. См. [требования Tauri](https://tauri.app/start/prerequisites/).

```sh
npm ci
npm run dev
```

Перед `tauri dev` и `tauri build` автоматически подготавливаются FFmpeg и FFprobe.
Версия и SHA-256 закреплены в [build/media-tools.json](../build/media-tools.json).
Поддерживаются Windows x64, Linux x64 и macOS x64/ARM64.
Первая подготовка требует доступа к GitHub для загрузки инструментов.

## Структура проекта

| Путь | Назначение |
| --- | --- |
| `web/` | Стартовый экран и выбор зеркала |
| `src-tauri/core/` | Приложение Tauri и команды для интерфейса |
| `src-tauri/shared/` | Состояние приложения и сервисы Rust |
| `src-tauri/module/` | Интеграция с интерфейсом Prisma |
| `src-tauri/module/media-audio.js` | Видео, PCM-аудио и встроенные субтитры |
| `src-tauri/capabilities/default.json` | Разрешения Tauri и удалённые адреса |
| `src-tauri/tauri.conf.json` | Конфигурация приложения и упаковки |
| `scripts/` | Подготовка инструментов и проверки |
| `.github/workflows/` | CI и выпуск релизов |

## Локальная сборка

Для сборки без приватного ключа апдейтера используйте разовое переопределение:

```sh
npm run tauri -- build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

В PowerShell используйте правила экранирования своей оболочки.
Альтернатива — передать в `--config` путь к локальному JSON-файлу:

```json
{"bundle":{"createUpdaterArtifacts":false}}
```

Это отключает только создание артефактов апдейтера. Подпись macOS сохраняется.
Не используйте `--no-sign` для распространяемых macOS-сборок: он отключает
подпись приложения и апдейтера. Не удаляйте публичный ключ из конфигурации.

Для выбора платформы добавьте `--target`:

| Платформа | Target |
| --- | --- |
| macOS ARM64 | `aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` |
| Linux x64 | `x86_64-unknown-linux-gnu` |
| Windows x64 | `x86_64-pc-windows-msvc` |

Сборка требует подходящей системы, установленного Rust target и зависимостей
платформы; один только `--target` не настраивает кросс-компиляцию.
Для macOS можно добавить `--bundles app` или `--bundles app,dmg`.
Результаты находятся в `src-tauri/target/.../release/bundle/`.

## Проверки

Перед прямым вызовом Cargo подготовьте инструменты для текущей платформы:

```sh
npm run prepare:media
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/check-commands-acl.mjs
node scripts/check-license-headers.mjs
node scripts/verify-media-audio.js
node scripts/verify-player-dispatch.js
node scripts/verify-external-progress-manager.js
```

Нативная проверка создаёт MKV, отдаёт его через локальный HTTP-сервер
и проверяет AC3/EAC3, перемотку, скорость, время ключевых кадров и субтитры:

```sh
cargo test --manifest-path src-tauri/Cargo.toml decodes_ac3_eac3_over_http_and_seeks_without_aac -- --ignored
```

На macOS можно проверить настоящий WKWebView и Web Audio. Проверка открывает
небольшое окно с синтетическим видео; вывод на динамики отключён.

```sh
cargo build --manifest-path src-tauri/Cargo.toml --example media_audio_webkit
PRISMA_TEST_MKV=1 swift -module-cache-path /tmp/prisma-webkit-swift-cache scripts/verify-media-webkit.swift \
  "$PWD/src-tauri/target/debug/examples/media_audio_webkit" \
  "$PWD/src-tauri/target/debug/prisma-ffmpeg" \
  "$PWD/src-tauri/target/debug/prisma-ffprobe"
```

Без `PRISMA_TEST_MKV=1` используется MP4. Через `PRISMA_TEST_URL` можно передать
свой прямой HTTP(S)-источник: проверка воспроизводит начало, перематывает
на минуту и проверяет наличие встроенных текстовых субтитров. Настройки
основного приложения не изменяются. Нужен доступ к локальному серверу
и оконному движку macOS.

## Версия и релизы

Источник версии — `package.json`. Tauri читает версию из этого файла;
`Cargo.toml` и `Cargo.lock` синхронизируются командой:

```sh
npm run sync:version
```

Команда `npm version patch` также запускает синхронизацию.
Публикация тега `v*` запускает платформенные сборки и выпуск релиза.
См. [main.yml](../.github/workflows/main.yml) и [updater.yml](../.github/workflows/updater.yml).
Linux собирается в Ubuntu 22.04 для совместимости с glibc 2.35.

Для подписанных артефактов автообновления нужны
`TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
Публичный ключ и адрес `latest.json` находятся в `src-tauri/tauri.conf.json`.
Подпись апдейтера и подпись приложения Apple — отдельные механизмы;
по умолчанию macOS-пакет получает ad-hoc подпись (`signingIdentity: "-"`),
включая FFmpeg и FFprobe. Это проверка целостности, а не подтверждение Apple.
Workflow проверяют подпись через `scripts/verify-macos-signature.sh`.
В `main.yml` приложение архивируется через `ditto`, чтобы сохранить права запуска.

Для распространения без ручного разрешения Gatekeeper нужны сертификат
**Developer ID Application** и notarization. В GitHub Secrets добавьте:

- `APPLE_CERTIFICATE`: экспортированный сертификат с приватным ключом `.p12`, в base64.
- `APPLE_CERTIFICATE_PASSWORD`: пароль `.p12`.
- `APPLE_SIGNING_IDENTITY`: имя сертификата Developer ID Application.
- `APPLE_ID`: почта Apple Developer.
- `APPLE_APP_SPECIFIC_PASSWORD`: пароль приложения для notarization.
- `APPLE_TEAM_ID`: идентификатор команды Apple Developer.

Оба workflow импортируют сертификат через `scripts/setup-macos-signing.sh`.
Если сертификат отсутствует, используется ad-hoc подпись; если он задан,
остальные секреты обязательны. Данные notarization передаются и повторной
попытке сборки. Одного имени сертификата в GitHub Secrets недостаточно.
Инструкция: [подпись macOS в Tauri](https://v2.tauri.app/distribute/sign/macos/).
Секреты и сертификаты не добавляйте в репозиторий.

FFmpeg и FFprobe упаковываются как sidecar-файлы `prisma-ffmpeg` и `prisma-ffprobe`.
В Windows portable они должны входить в архив вместе с папкой `media-tools`.
Сведения об исходниках и лицензиях см. в
[описании мультимедийных инструментов](../src-tauri/resources/media-tools/README.md).

## Конфигурация

Адрес зеркала хранится в ключе `prismaUrl`. Например, на macOS файл настроек
находится в `~/Library/Application Support/com.prisma.desktop/store.json`.
Разрешения и список удалённых адресов задаются в
`src-tauri/capabilities/default.json`; настройки ATS для macOS —
в `src-tauri/macos-info.plist`.
