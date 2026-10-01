#!/usr/bin/env node
// Prisma Desktop — десктопный клиент Prisma на Tauri.
// Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "build/media-tools.json"), "utf8"));
const hostTargets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const hostTarget = hostTargets[`${process.platform}-${process.arch}`];
const target = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget;
const entries = manifest.platforms[target];
if (!entries) throw new Error(`Нет закреплённой сборки FFmpeg для ${target}`);
const output = path.join(root, "src-tauri/resources/media-tools");
const binaries = path.join(root, "src-tauri/binaries");
await fs.mkdir(output, { recursive: true });
await fs.mkdir(binaries, { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const entry of entries) {
  const sidecarName = `prisma-${entry.file.replace(/\.exe$/, "")}-${target}${entry.file.endsWith(".exe") ? ".exe" : ""}`;
  const destination = entry.executableSha256 ? path.join(binaries, sidecarName) : path.join(output, entry.file);
  const expected = entry.executableSha256 || entry.sha256;
  const cached = await fs.readFile(destination).catch(() => null);
  if (cached && digest(cached) === expected) continue;
  // Migrate an already prepared resource binary to a sidecar without downloading.
  const previous = entry.executableSha256 && await fs.readFile(path.join(output, entry.file)).catch(() => null);
  if (previous && digest(previous) === expected) {
    await fs.writeFile(destination, previous, { mode: 0o755 });
    continue;
  }
  const url = `https://github.com/${manifest.repository}/releases/download/${manifest.tag}/${entry.asset}`;
  console.log(`Download ${entry.asset}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${entry.asset}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (digest(archive) !== entry.sha256) throw new Error(`${entry.asset}: SHA-256 не совпадает`);
  const bytes = entry.executableSha256 ? gunzipSync(archive) : archive;
  if (digest(bytes) !== expected) throw new Error(`${entry.file}: SHA-256 не совпадает`);
  await fs.writeFile(`${destination}.tmp`, bytes, { mode: 0o755 });
  await fs.rename(`${destination}.tmp`, destination);
}

// Avoid accidentally shipping the previous target's tools when cross-building.
const files = new Set([...entries.filter((e) => !e.executableSha256).map((e) => e.file), "README.md", "manifest.json"]);
for (const file of await fs.readdir(output)) {
  if (!files.has(file)) await fs.unlink(path.join(output, file));
}
await fs.writeFile(path.join(output, "manifest.json"), `${JSON.stringify({ target, ...manifest }, null, 2)}\n`);
if (target === hostTarget) {
  const ffmpeg = path.join(binaries, `prisma-ffmpeg-${target}${process.platform === "win32" ? ".exe" : ""}`);
  const decoders = execFileSync(ffmpeg, ["-hide_banner", "-decoders"], { encoding: "utf8", timeout: 10000 });
  for (const codec of ["ac3", "eac3"]) {
    if (!new RegExp(`\\s${codec}\\s`).test(decoders)) throw new Error(`В FFmpeg отсутствует декодер ${codec}`);
  }
}
console.log(`FFmpeg/FFprobe ready: ${target} (${manifest.tag}, SHA-256 verified)`);
