#!/bin/bash
# Fetch a static ffmpeg for serverless per-segment transcoding (the data-saver
# quality ladder + HEVC conversion on Vercel).
#
# Target: third_party/ffmpeg/ffmpeg  (gitignored — downloaded at build time,
# traced into the /api/turbo function bundle via outputFileTracingIncludes).
#
# Why BtbN n8.1: a modern static-ish x86_64 build (glibc >= 2.28 — runs on
# Amazon Linux 2023 lambdas) whose HEVC decoder handles the premium CDN's HEVC
# phases. The smaller johnvansickle 7.0.2 build segfaults on those streams.
#
# Idempotent: skips when a working binary exists. Fail-soft: a failed download
# just hides the segment ladder (native playback is untouched).
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)/third_party/ffmpeg"
BIN="$DIR/ffmpeg"
mkdir -p "$DIR"

works() { [ -x "$BIN" ] && "$BIN" -version >/dev/null 2>&1; }

if works; then echo "[fetch-ffmpeg] cached: $BIN"; exit 0; fi

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "[fetch-ffmpeg] non-linux-amd64 host — skipping (PATH ffmpeg still used when present)"
  exit 0
fi

URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
echo "[fetch-ffmpeg] downloading $URL"
if curl -fsSL --retry 3 --connect-timeout 25 -o "$DIR/ff.tar.xz" "$URL"; then
  mkdir -p "$DIR/x"
  if tar -xJf "$DIR/ff.tar.xz" -C "$DIR/x" --wildcards "*/bin/ffmpeg"; then
    FOUND=$(find "$DIR/x" -name ffmpeg -type f | head -1)
    if [ -n "$FOUND" ]; then
      mv "$FOUND" "$BIN"
      chmod +x "$BIN"
    fi
  fi
  rm -rf "$DIR/x" "$DIR/ff.tar.xz"
fi

if works; then
  echo "[fetch-ffmpeg] ok: $("$BIN" -version 2>/dev/null | head -1)"
else
  rm -f "$BIN"
  echo "[fetch-ffmpeg] unavailable — the serverless data-saver ladder stays hidden"
fi
exit 0
