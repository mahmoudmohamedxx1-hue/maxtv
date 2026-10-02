import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // data/iptv playlists (incl. the curated LadderAlts pool) must ship with the
  // standalone server — the catalog + alternates engine reads them at runtime
  outputFileTracingIncludes: {
    "/api/**": ["./data/iptv/**"],
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
