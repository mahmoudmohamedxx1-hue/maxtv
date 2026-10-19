// Debug route — exposes the in-memory catalog state (sourceHealth, source
// counts, total channels, etc.) so we can diagnose why the catalog endpoint
// returns 0 sources while /api/sports/channels works fine.

import { getCatalog } from '@/lib/iptv/catalog';
import { probeSource } from '@/lib/iptv/health';
import { setProxyOriginFromRequest } from '@/lib/streaming/upstream';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: Request) {
  setProxyOriginFromRequest(req);
  const catalog = await getCatalog();

  // Probe a sample channel from each source to see what status the probe
  // returns. This is the same probe the catalog build runs.
  const probeSample: { source: string; okCount: number; probed: number; health: string }[] = [];
  const bySource = new Map<string, typeof catalog.channels>();
  for (const ch of catalog.channels) {
    if (!bySource.has(ch.source)) bySource.set(ch.source, []);
    bySource.get(ch.source)!.push(ch);
  }
  for (const [id, chs] of bySource) {
    if (id === 'bein' || id === 'worldsports') continue; // sports — skip
    const status = await probeSource(id, chs.slice(0, 3));
    probeSample.push({
      source: id,
      okCount: status.okCount,
      probed: status.probed,
      health: status.health,
    });
  }

  return Response.json({
    catalogBuiltAt: catalog.builtAt,
    catalogAgeMs: Date.now() - catalog.builtAt,
    totalChannels: catalog.channels.length,
    totalSportsChannels: catalog.sportsChannels.length,
    totalOtherChannels: catalog.otherChannels.length,
    totalSources: catalog.sources.length,
    sourceHealth: catalog.sourceHealth,
    probeSample,
  });
}
