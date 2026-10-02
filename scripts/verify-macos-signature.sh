#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Verify the bundle seal and both bundled media executables.
set -euo pipefail
app="${1:?Usage: verify-macos-signature.sh /path/to/Prisma.app}"
codesign --verify --deep --strict --verbose=2 "$app"
for binary in Prisma prisma-ffmpeg prisma-ffprobe; do
  test -x "$app/Contents/MacOS/$binary"
  codesign --verify --strict --verbose=2 "$app/Contents/MacOS/$binary"
done
