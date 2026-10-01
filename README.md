# Prisma Desktop

Prisma Desktop на **Tauri v2 + Rust**.

Внешние плееры, встроенный TorrServer, нативные функции и автообновление релизов.

## Возможности

- Смена зеркала Prisma (`http://prisma.ws` по умолчанию)
- Экран выбора зеркала при первом запуске и при недоступности сохранённого адреса
- История зеркал: последние рабочие адреса предлагаются в один клик, при старте перебираются автоматически
- macOS: пункт меню «Сменить зеркало…» (⌘⇧M) открывает модаль смены адреса
- Windows/Linux: адрес меняется на стартовом экране и в настройках Prisma (меню окна нет, чтобы не занимать место)
- Desktop bridge/inject для клиентского кода
- Встроенный TorrServer: установка, запуск, остановка, статус, обновление, удаление
- Запуск внешних плееров; на Windows Настройки —  Плеер — Тип плеера
- Локальный импорт/экспорт настроек
- Автообновление приложения (для установленной версии)

## Стек

- Tauri 2
- Rust
- JavaScript (`bridge.js`, `client-inject.js`)

## Структура

- `web/` — frontend ресурсы
- `src-tauri/core/` — Rust backend и Tauri команды
- `src-tauri/module/bridge.js` — bridge API для WebView
- `src-tauri/module/client-inject.js` — клиентский inject
- `src-tauri/module/mirror-modal.js` — модаль смены зеркала
- `web/index.html` — стартовый экран выбора зеркала
- `src-tauri/capabilities/default.json` — permissions и remote URLs
- `src-tauri/macos-info.plist` — ATS настройки для macOS
- `.github/workflows/main.yml` — сборка артефактов (all platforms)
- `.github/workflows/updater.yml` — релиз/апдейтер артефакты

## Версия

Единственный источник — `version` в `package.json`. `tauri.conf.json` читает её оттуда
(`"version": "../package.json"`), `Cargo.toml` и `Cargo.lock` синхронизирует скрипт:

```bash
npm run sync:version     # вручную
npm version patch        # бампит package.json и синхронизирует сам
```

## Требования

- Node.js 20+
- npm
- Rust toolchain (`rustup`)
- системные зависимости Tauri: [https://tauri.app/start/prerequisites/](https://tauri.app/start/prerequisites/)

## Быстрый старт

```bash
npm ci
npm run dev
```

## Команды

```bash
npm run dev         # dev запуск
npm run build       # production сборка текущей платформы
npm run check:rust  # cargo check
npm run tauri       # tauri CLI
```

## Локальные сборки

> Локальная сборка требует ключа апдейтера или флага `--no-sign` — см.
> [«Локальная сборка: не выключайте апдейтер в репозитории»](#-локальная-сборка-не-выключайте-апдейтер-в-репозитории).

### macOS ARM64

```bash
npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg
```

### macOS x64

```bash
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin --bundles app
```

### Linux x64

```bash
npm run tauri -- build --target x86_64-unknown-linux-gnu
```

### Windows x64

```bash
npm run tauri -- build --target x86_64-pc-windows-msvc
```

## CI/CD

- Пуш тега `v*` запускает:
  - `main.yml` — платформенные артефакты
  - `updater.yml` — release + updater артефакты

## Автообновление

- Настраивается в `src-tauri/tauri.conf.json` (`plugins.updater`)
- Требует signing keys (`TAURI_SIGNING_PRIVATE_KEY`)
- Для macOS релизов требуется Apple signing/notarization secrets
- На Windows **portable**-сборке автообновление отключено (показывается сообщение о ручном обновлении через GitHub Releases)

### ⚠️ Локальная сборка: не выключайте апдейтер в репозитории

Локальный `npm run build` падает с ошибкой:

```
A public key has been found, but no private key.
Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
```

Это нормально: в `tauri.conf.json` лежит публичный ключ апдейтера, а приватного на вашей
машине нет. **Чинить это правкой репозитория нельзя.** Не делайте ничего из списка ниже
и не коммитьте такие изменения:

- не убирайте `plugins.updater` или `pubkey` из `src-tauri/tauri.conf.json`;
- не ставьте `"createUpdaterArtifacts": false` в конфиге;
- не добавляйте `--no-sign` и `--config '{"bundle":{"createUpdaterArtifacts":false}}'`
в `.github/workflows/updater.yml`.

Любое из этих действий убирает из релиза `latest.json` и файлы `.sig`, и автообновление
у всех пользователей молча перестаёт работать: приложение просто не находит новую версию.
Именно так автообновление сломалось между v1.2.1 и v1.2.2.

Правильные способы собрать локально:

```bash
# 1) Разово отключить апдейтер только для своей сборки — флагом, без правки файлов
npm run tauri -- build --no-sign

# 2) Или подписывать своим тестовым ключом
npm run tauri -- signer generate -w ~/.tauri/prisma-test.key -p ""
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/prisma-test.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run tauri -- build
```

Отдельно про `--no-sign`: в справке CLI написано «skip code signing», но по факту он
отключает **и подпись апдейтера** (`Updater signing is skipped due to --no-sign flag`).
Для локальной сборки это удобно, в релизном workflow — недопустимо.

## Артефакты

- macOS: `.app`, `.dmg`
- Linux: `.AppImage`, `.deb`, `.rpm`
- Windows: `.msi`, `.exe` (NSIS), `Prisma-portable-x64.zip`

## Linux: совместимость и известные проблемы

Релизы собираются в контейнере Ubuntu 22.04, поэтому бинарник требует glibc 2.35+
и WebKitGTK 4.1: Ubuntu 22.04+, Debian 12+, Fedora 36+, openSUSE Leap 15.5+, Arch.
На более старых дистрибутивах (Ubuntu 20.04, Debian 11) пакет не установится, а
AppImage не запустится — там нет `libwebkit2gtk-4.1`.

- **AppImage не запускается, ошибка про `libfuse.so.2`.** Установите `libfuse2`
  (`sudo apt install libfuse2`, на Fedora `fuse`) или запустите без FUSE:
  `./Prisma.AppImage --appimage-extract-and-run`.
- **Белое окно или падение при старте на NVIDIA.** Приложение само отключает
  DMA-BUF рендерер WebKit, если найден проприетарный драйвер. Если не помогло:
  `WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Prisma.AppImage`.
- **Проблемы на Wayland** (чёрное окно, не работает fullscreen):
  `GDK_BACKEND=x11 ./Prisma.AppImage`.
- **Встроенный плеер не воспроизводит видео.** AppImage везёт кодеки GStreamer
  с собой. Для `.deb`/`.rpm` они идут в Recommends: `gstreamer1.0-plugins-good`,
  `gstreamer1.0-plugins-bad`, `gstreamer1.0-libav` (Fedora: `gstreamer1-plugins-good`,
  `gstreamer1-plugins-bad-free`, `gstreamer1-libav` из RPM Fusion).

## Конфигурация

### AC3/EAC3 во встроенном плеере

Встроенный плеер поддерживает звук AC3 (Dolby Digital) и EAC3 (Dolby Digital
Plus) через нативный FFmpeg, без Electron. Для прямого HTTP(S)-потока, в том
числе MKV из TorrServer, FFprobe определяет аудиодорожки. Если в файле есть
AC3/EAC3, звук выбранной дорожки декодируется в PCM 48 кГц и воспроизводится
через Web Audio. Видео продолжает воспроизводить системный WebView.

Работают штатное меню аудиодорожек, пауза, перемотка, громкость, отключение
звука и изменение скорости с сохранением высоты звука. На паузе и при закрытии плеера FFmpeg останавливается;
при перемотке декодирование начинается с новой позиции. Буферы ограничены,
целиком загружать или преобразовывать фильм не нужно. FFmpeg получает аудио
отдельным HTTP-запросом; для перемотки источник должен поддерживать Range.

PCM сохраняет моно, стерео, 4, 5.1 и 7.1 канала; Web Audio выводит их в пределах
возможностей устройства, автоматически сводя звук для стереовыхода. Это
программное декодирование, без HDMI passthrough/Atmos. Поддержка
видеокодека и контейнера по-прежнему зависит от системного WebView: например,
этот аудиодекодер сам по себе не добавляет MKV или HEVC в WKWebView. HLS/DASH,
DRM и IPTV в эту обработку не включаются и используют обычный механизм плеера.

FFmpeg и FFprobe входят в установщики и Windows portable. Для сборки закреплены
версия `b6.1.1` и SHA-256 в `build/media-tools.json`; инструменты автоматически
подготавливаются перед `tauri build` для Windows x64, Linux x64, macOS x64/ARM64.
Лицензии и сведения об исходниках поставляются в `media-tools`; исполняемые
файлы упаковываются как sidecar (`prisma-ffmpeg`, `prisma-ffprobe`) и входят
в подпись приложения macOS. `tauri dev` тоже подготавливает их автоматически.
Перед прямым запуском `cargo check`/`cargo test` выполните `npm run prepare:media`.

Проверки: `node scripts/verify-media-audio.js` и, после подготовки инструментов,
`cargo test --manifest-path src-tauri/Cargo.toml decodes_ac3_eac3_over_http_and_seeks_without_aac -- --ignored`.
Вторая проверка создаёт MKV с обеими дорожками, воспроизводит звук через HTTP
и сравнивает PCM после перемотки с непрерывно декодированным звуком.

На macOS можно проверить настоящий WKWebView и Web Audio синтетическим MP4
с AC3/EAC3, без вывода звука на динамики:

```sh
cargo build --manifest-path src-tauri/Cargo.toml --example media_audio_webkit
swift -module-cache-path /tmp/prisma-webkit-swift-cache scripts/verify-media-webkit.swift \
  "$PWD/src-tauri/target/debug/examples/media_audio_webkit" \
  "$PWD/src-tauri/target/debug/prisma-ffmpeg" \
  "$PWD/src-tauri/target/debug/prisma-ffprobe"
```

Проверка требует доступа к оконному движку macOS и локальному HTTP-серверу.

### Prisma URL

- Store key: `prismaUrl`
- Пример store на macOS: `~/Library/Application Support/com.prisma.desktop/store.json`

### Remote URLs / permissions

- `src-tauri/capabilities/default.json`

## Лицензия

Проект распространяется под [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
Каждый файл исходников содержит заголовок с указанием лицензии.
