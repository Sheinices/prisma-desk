#!/usr/bin/env node
// Единственный источник версии — package.json.
// tauri.conf.json читает её сам ("version": "../package.json"),
// а Cargo.toml/Cargo.lock подтягиваются этим скриптом:
//   npm run sync:version
// Также запускается автоматически при `npm version <патч|минор|...>`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");

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

console.log(`версия синхронизирована: ${version}`);
