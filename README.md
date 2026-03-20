# Prisma Desktop

Prisma Desktop на **Tauri v2 + Rust**.

Внешние плееры, встроенный TorrServer, нативные функции и автообновление релизов.

## Возможности
- Смена зеркала Prisma (`http://prisma.ws` по умолчанию)
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
- `src-tauri/capabilities/default.json` — permissions и remote URLs
- `src-tauri/macos-info.plist` — ATS настройки для macOS
- `.github/workflows/main.yml` — сборка артефактов (all platforms)
- `.github/workflows/updater.yml` — релиз/апдейтер артефакты

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

