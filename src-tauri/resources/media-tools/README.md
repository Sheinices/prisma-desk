This directory is populated by `node scripts/prepare-media-tools.mjs` before a
release build. Executables are prepared in `src-tauri/binaries` as Tauri
sidecars, so the macOS bundler signs them together with the application.
Do not commit downloaded binaries.

FFmpeg and FFprobe come from the pinned `eugeneware/ffmpeg-static` release in
`build/media-tools.json`. SHA-256 hashes are verified for both compressed assets
and executables. The matching upstream license and README/source notices travel
with the binaries as `FFmpeg-LICENSE.txt` and `FFmpeg-README.txt`.

Source and build instructions: https://github.com/eugeneware/ffmpeg-static
FFmpeg source: https://ffmpeg.org/download.html
Individual build/source links and licenses are in the platform's bundled README.
