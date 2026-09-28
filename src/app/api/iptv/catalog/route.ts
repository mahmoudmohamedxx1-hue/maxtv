import { NextResponse } from 'next/server';
import { getCatalog } from '@/lib/iptv/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  const catalog = await getCatalog();
  return NextResponse.json(
    {
      categories: catalog.categories,
      sources: catalog.sources.filter((s) => s.id !== 'tvpass' && s.id !== 'thetvapp' && s.id !== 'pixelsports'),
      total: catalog.otherChannels.length,
      builtAt: catalog.builtAt,
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}
