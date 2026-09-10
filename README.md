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
- Запуск внешних плееров
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
- системные зависимости Tauri: <https://tauri.app/start/prerequisites/>

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

## Конфигурация

### Prisma URL
- Store key: `prismaUrl`
- Пример store на macOS: `~/Library/Application Support/com.prisma.desktop/store.json`

### Remote URLs / permissions
- `src-tauri/capabilities/default.json`
