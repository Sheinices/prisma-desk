#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Import a Developer ID certificate on an ephemeral GitHub Actions runner.
set -euo pipefail
if [[ -z "${APPLE_CERTIFICATE:-}" ]]; then
  echo "No Developer ID certificate configured; using ad-hoc signing."
  exit 0
fi
: "${APPLE_CERTIFICATE_PASSWORD:?Missing APPLE_CERTIFICATE_PASSWORD}"
: "${SIGNING_IDENTITY:?Missing APPLE_SIGNING_IDENTITY}"
: "${NOTARY_ID:?Missing APPLE_ID}"
: "${NOTARY_PASSWORD:?Missing APPLE_APP_SPECIFIC_PASSWORD}"
: "${NOTARY_TEAM:?Missing APPLE_TEAM_ID}"
: "${RUNNER_TEMP:?Run this script in GitHub Actions}"
: "${GITHUB_ENV:?Missing GITHUB_ENV}"
certificate="$RUNNER_TEMP/prisma-signing.p12"
keychain="$RUNNER_TEMP/prisma-signing.keychain-db"
keychain_password=$(openssl rand -hex 32)
trap 'rm -f "$certificate"' EXIT
printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# Preserve the runner's existing keychains.
existing_keychains=()
while IFS= read -r entry; do
  entry="${entry//\"/}"
  entry="${entry#"${entry%%[![:space:]]*}"}"
  [[ -z "$entry" ]] || existing_keychains+=("$entry")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain" "${existing_keychains[@]}"
security find-identity -v -p codesigning "$keychain"
# Credentials are supplied to Tauri only when a real certificate is imported.
{
  printf 'APPLE_SIGNING_IDENTITY=%s\n' "$SIGNING_IDENTITY"
  printf 'APPLE_ID=%s\n' "$NOTARY_ID"
  printf 'APPLE_PASSWORD=%s\n' "$NOTARY_PASSWORD"
  printf 'APPLE_TEAM_ID=%s\n' "$NOTARY_TEAM"
} >> "$GITHUB_ENV"
