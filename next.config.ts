import type { NextConfig } from "next";

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
