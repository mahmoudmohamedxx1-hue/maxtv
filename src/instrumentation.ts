// ─── Server startup warmup ──────────────────────────────────────────────────
// Next.js instrumentation hook: runs once when the server process boots.
// The #1 cause of "home loads without content" is cold caches — the first
// visitor pays for the DaddyLive scrape (~5s) + catalog build (~4s) + logo
// enrichment. Warming them at boot means every visitor gets instant data.

export async function register() {
  // only run in the node.js server runtime, not during edge/worker builds
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const warm = async () => {
    try {
      // 0. big-league fixture calendars (TheSportsDB — rate-limited, start early)
      const { warmBigLeagues } = await import('@/lib/sports/bigleagues');
      warmBigLeagues();

      // 1. sports schedule (DaddyLive scrape, 60s TTL)
      const { getSchedule, get247Channels } = await import('@/lib/sports/daddylive');
      void getSchedule().catch(() => {});
      void get247Channels().catch(() => {});

      // 2. others catalog (m3u parse + health), fire-and-forget
      const { getCatalog } = await import('@/lib/iptv/catalog');
      void getCatalog().catch(() => {});

      // 3. hit our own HTTP endpoints so route code compiles + enrichment
      //    caches fill before any real user touches them
      const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
      const ping = (path: string) =>
        fetch(`${base}${path}`, { cache: 'no-store' }).catch(() => {});
      // wait briefly for the dev/prod server to accept connections
      for (let i = 0; i < 30; i++) {
        const ok = await fetch(`${base}/api/sports/schedule`, { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      void ping('/api/sports/channels');
      void ping('/api/iptv/catalog');
    } catch {
      // warmup is best-effort — never block server startup
    }
  };

  void warm();
}
