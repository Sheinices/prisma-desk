#!/usr/bin/env node
// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

// Единственный источник версии — package.json.
// tauri.conf.json читает её сам ("version": "../package.json"),
// а Cargo.toml/Cargo.lock подтягиваются этим скриптом:
//   npm run sync:version
// Также запускается автоматически при `npm version <патч|минор|...>`.
// С флагом --check ничего не пишет, а падает, если версии разъехались (для CI).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");

const checkOnly = process.argv.includes("--check");
const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json: некорректная версия "${version}"`);
  process.exit(1);
}

function update(file, pattern, replacement) {
  if (!fs.existsSync(file)) return false;

  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);

  if (before === after) return false;

  if (checkOnly) {
    console.error(`${path.relative(root, file)}: версия не совпадает с package.json (${version})`);
    process.exitCode = 1;
    return true;
  }

  fs.writeFileSync(file, after);
  console.log(`${path.relative(root, file)} → ${version}`);
  return true;
}

// [package] ... version = "x.y.z" — только первое вхождение, до [lib]
update(cargoTomlPath, /^version = ".*"$/m, `version = "${version}"`);

// В Cargo.lock правим запись именно нашего пакета
update(
  cargoLockPath,
  /(\[\[package\]\]\nname = "Prisma"\nversion = )"[^"]*"/,
  `$1"${version}"`,
);

const tauriConf = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);

if (tauriConf.version !== "../package.json") {
  console.warn(
    'внимание: в tauri.conf.json поле "version" не указывает на ../package.json — версия бандла может разъехаться',
  );
}

if (process.exitCode) {
  console.error("запустите `npm run sync:version`, чтобы выровнять версии");
} else {
  console.log(checkOnly ? `версии совпадают: ${version}` : `версия синхронизирована: ${version}`);
}
