import { NextResponse } from 'next/server';
import { getSchedule } from '@/lib/sports/daddylive';
import { get247Channels } from '@/lib/sports/daddylive';
import { getCatalog } from '@/lib/iptv/catalog';
import { getChannelLogo } from '@/lib/media/logos';

export const dynamic = 'force-dynamic';

/**
 * Global search across sports matches, 24/7 sports channels and the
 * full IPTV catalog. GET /api/search?q=...
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  if (q.length < 2) {
    return NextResponse.json({ matches: [], sports: [], channels: [] });
  }

  const [matches, ch247, catalog] = await Promise.all([getSchedule(), get247Channels(), getCatalog()]);

  const matchHits = matches
    .filter((m) => `${m.title} ${m.league}`.toLowerCase().includes(q))
    .slice(0, 12)
    .map((m) => ({
      id: m.id,
      title: m.title,
      league: m.league,
      category: m.category,
      startTime: m.startTime,
      status: m.status,
      channels: m.channels.slice(0, 6),
      kind: 'match' as const,
    }));

  const sportChHits = ch247
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 15)
    .map((c) => ({
      id: `dl247:${c.id}`,
      name: c.name,
      kind: 'daddylive' as const,
      ref: c.id,
      source: 'DaddyLive 24/7',
      logo: getChannelLogo(c.name) || undefined,
    }));

  const iptvHits = catalog.channels
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 30)
    .map((c) => ({
      id: c.id,
      name: c.name,
      logo: c.logo,
      kind: 'iptv' as const,
      ref: c.url,
      source: catalog.sources.find((s) => s.id === c.source)?.name || c.source,
      category: c.category,
    }));

  return NextResponse.json(
    { matches: matchHits, sports: sportChHits, channels: iptvHits },
    { headers: { 'cache-control': 'public, max-age=30' } }
  );
}
