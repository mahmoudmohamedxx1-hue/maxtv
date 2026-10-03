import type { NextConfig } from "next";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// ── serverless transcode binary (build-time) ────────────────────────────────
// The per-segment data-saver ladder (&h= quality rungs in /api/turbo) needs a
// static ffmpeg inside the serverless bundle. Downloaded at BUILD time by
// scripts/fetch-ffmpeg.sh (gitignored, idempotent, fail-soft — a failed
// download just hides the ladder; native playback is untouched). Running it
// from the config means EVERY `next build` (local, CI, Vercel) fetches it,
// regardless of the platform's build-command settings.
if (process.env.NODE_ENV !== "development") {
  try {
    const bin = path.join(process.cwd(), "third_party", "ffmpeg", "ffmpeg");
    const works = () => {
      try {
        return fs.existsSync(bin) && fs.accessSync(bin, fs.constants.X_OK) === undefined;
      } catch {
        return false;
      }
    };
    if (!works()) {
      execSync("bash scripts/fetch-ffmpeg.sh", { stdio: "inherit", cwd: process.cwd() });
    }
  } catch {
    // fail-soft: the ladder stays hidden, everything else keeps working
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  // data/iptv playlists (incl. the curated LadderAlts pool) must ship with the
  // standalone server — the catalog + alternates engine reads them at runtime.
  // third_party/ffmpeg is the build-time static binary powering the serverless
  // per-segment data-saver ladder (&h= quality rungs + HEVC conversion) in
  // /api/turbo.
  outputFileTracingIncludes: {
    "/api/**": ["./data/iptv/**"],
    "/api/turbo": ["./third_party/ffmpeg/ffmpeg"],
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
