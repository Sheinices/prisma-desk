#!/usr/bin/env node
// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
//
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Prisma Desktop, licensed under the GNU Affero General
// Public License v3.0. See the LICENSE file in the project root for details.

// Сверяет три списка команд приложения, которые должны совпадать:
//   - generate_handler! в src-tauri/core/lib.rs
//   - APP_COMMANDS в src-tauri/build.rs (генерирует разрешения)
//   - allow-* в src-tauri/capabilities/default.json (выдаёт их окну)
// Если команда есть не везде, с зеркала она отклоняется как «not allowed».
//
//   node scripts/check-commands-acl.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const handlerBlock = read("src-tauri/core/lib.rs").match(/generate_handler!\[([\s\S]*?)\]/);
const handler = new Set((handlerBlock?.[1] || "").match(/[a-z_][a-z0-9_]*/g) || []);

const buildBlock = read("src-tauri/build.rs").match(/APP_COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/);
const build = new Set((buildBlock?.[1] || "").match(/"([a-z_][a-z0-9_]*)"/g)?.map((s) => s.slice(1, -1)) || []);

const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
const allowed = new Set(
  capability.permissions
    .filter((p) => typeof p === "string" && p.startsWith("allow-"))
    .map((p) => p.slice("allow-".length).replace(/-/g, "_")),
);

let ok = true;
const report = (label, missing) => {
  if (missing.length === 0) return;
  ok = false;
  console.error(`${label}: ${missing.join(", ")}`);
};

const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();
report("нет в build.rs APP_COMMANDS", diff(handler, build));
report("нет в capabilities/default.json", diff(handler, allowed));
report("лишние в build.rs (нет в generate_handler)", diff(build, handler));
report("лишние в capabilities (нет в generate_handler)", diff(allowed, handler));

if (!ok) process.exit(1);
console.log(`ACL команд согласован: ${handler.size} команд`);
