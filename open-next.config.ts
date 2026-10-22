// OpenNext for Cloudflare — adapter config (full explicit shape; the CLI's
// config validator enforces the cloudflare wrappers/converter).
// No KV/D1/R2 bindings: the app's API routes are stateless-per-invocation by
// architecture (the turbo engine keeps per-isolate state on globalThis;
// cross-isolate tolerance is built in via upstream-sn identity — see
// src/lib/streaming/turbo.ts). "dummy" caches = ISR is not used; every API
// route is force-dynamic and pages are prerendered into static assets.
import type { OpenNextConfig } from "@opennextjs/cloudflare";

const config: OpenNextConfig = {
  default: {
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "direct",
    },
  },
  edgeExternals: ["node:crypto"],
  middleware: {
    external: true,
    override: {
      wrapper: "cloudflare-edge",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "dummy",
    },
  },
};

export default config;
