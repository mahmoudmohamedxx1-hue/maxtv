import { NextResponse } from 'next/server';
import { getCatalog } from '@/lib/iptv/catalog';

export const dynamic = 'force-dynamic';

/**
 * Channel list for the OTHERS tab.
 * GET /api/iptv/channels?category=movies&source=pluto&q=&limit=60&offset=0
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category') || 'all';
  const source = searchParams.get('source') || '';
  const q = (searchParams.get('q') || '').toLowerCase().trim();
  const limit = Math.min(parseInt(searchParams.get('limit') || '60', 10) || 60, 300);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10) || 0, 0);

  const catalog = await getCatalog();
  let list = catalog.otherChannels;

  if (category !== 'all') list = list.filter((c) => c.category === category);
  if (source) list = list.filter((c) => c.source === source);
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));

  // Stable ordering: healthy sources first (ok > geo > unknown), then name —
  // so the default grid leads with channels that actually play.
  const healthTier = (srcId: string) => {
    const h = catalog.sourceHealth[srcId];
    return h === 'ok' ? 0 : h === 'geo' ? 1 : 2;
  };
  list = [...list].sort(
    (a, b) =>
      healthTier(a.source) - healthTier(b.source) ||
      a.source.localeCompare(b.source) ||
      a.name.localeCompare(b.name)
  );

  const page = list.slice(offset, offset + limit);
  return NextResponse.json(
    {
      channels: page.map((c) => ({
        id: c.id,
        name: c.name,
        logo: c.logo,
        group: c.group,
        category: c.category,
        source: c.source,
        sourceName: catalog.sources.find((s) => s.id === c.source)?.name || c.source,
        kind: 'iptv' as const,
        ref: c.url,
        chno: c.chno,
      })),
      total: list.length,
      offset,
      limit,
    },
    { headers: { 'cache-control': 'public, max-age=120' } }
  );
}
