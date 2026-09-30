#!/usr/bin/env node
// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

// Проверяет, что в каждом файле исходников, отслеживаемом git, есть
// SPDX-заголовок. JSON и бинарные файлы комментариев не поддерживают
// и не проверяются.
//
//   node scripts/check-license-headers.mjs

import { execFileSync } from "child_process";
import fs from "fs";

const EXTENSIONS = /\.(rs|js|mjs|css|html|ps1|yml|yaml|plist)$/;
const MARKER = "SPDX-License-Identifier: AGPL-3.0-only";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => EXTENSIONS.test(file));

const missing = tracked.filter((file) => {
  const head = fs.readFileSync(file, "utf8").slice(0, 1024);
  return !head.includes(MARKER);
});

if (missing.length > 0) {
  console.error("Нет заголовка лицензии в файлах:");
  for (const file of missing) console.error(`  ${file}`);
  process.exit(1);
}

console.log(`заголовок лицензии есть во всех ${tracked.length} файлах`);
