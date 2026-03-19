# Prisma Desktop

Нативное десктоп-приложение Prisma на **Tauri v2 + Rust**.

Десктоп-клиент Prisma с интеграциями для внешних плееров и TorrServer. Сборка: macOS, Linux, Windows.

## Ключевые возможности
- Нативное окно приложения с загрузкой Prisma (`http://prisma.ws` по умолчанию)
- Desktop bridge/inject для интеграции с клиентским кодом
- Управление TorrServer: установка, запуск, остановка, статус, обновление, удаление
- Запуск внешних плееров
- Локальный импорт/экспорт настроек через файл

## Технологический стек
- Tauri 2
- Rust
- JavaScript (bridge + client inject)

## Структура репозитория
- `web/` — frontend-ресурсы
- `src-tauri/core/` — Rust backend и команды Tauri
- `src-tauri/module/bridge.js` — bridge API в WebView
- `src-tauri/module/client-inject.js` — клиентский inject
- `src-tauri/capabilities/default.json` — whitelist удаленных URL
- `src-tauri/macos-info.plist` — macOS ATS исключения для `http://` источников
- `.github/workflows/build-all-platforms.yml` — CI сборка под все платформы

## Требования к окружению
- Node.js 20+
- npm
- Rust toolchain (рекомендуется `rustup`)
- Системные зависимости Tauri: https://tauri.app/start/prerequisites/

## Быстрый старт
```bash
npm ci
npm run dev
```

## Команды проекта
```bash
npm run dev         # запуск в dev-режиме
npm run build       # production-сборка для текущей платформы
npm run check:rust  # cargo check
npm run tauri       # прямой доступ к tauri CLI
```

## Production-сборки

### macOS Apple Silicon (ARM64)
```bash
npm run tauri -- build --target aarch64-apple-darwin --bundles app,dmg
```

### macOS Intel (x64)
```bash
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin --bundles app,dmg
```

Если кросс-упаковка `dmg` на ARM-хосте нестабильна:
```bash
npm run tauri -- build --target x86_64-apple-darwin --bundles app
```

### Linux / Windows
Рекомендуется нативная сборка на соответствующей ОС или CI workflow:
- `.github/workflows/build-all-platforms.yml`

## Артефакты сборки
- macOS ARM: `src-tauri/target/aarch64-apple-darwin/release/bundle/`
- macOS Intel: `src-tauri/target/x86_64-apple-darwin/release/bundle/`
- Linux: `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/`
- Windows: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`

## Конфигурация

### URL Prisma
Хранится в store как `prismaUrl`.
Путь к store на macOS:
- `~/Library/Application Support/com.prisma.desktop/store.json`

Дефолтное значение:
- `http://prisma.ws`

### Разрешенные remote URL
Настраиваются в:
- `src-tauri/capabilities/default.json`
