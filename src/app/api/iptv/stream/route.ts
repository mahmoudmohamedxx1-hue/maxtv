import { NextResponse } from 'next/server';
import { resolveRedirects, cleanTemplateParams } from '@/lib/streaming/resolve';
import { proxyUrlFor } from '@/lib/streaming/proxy';
import { findAlternates, type AlternateChannel } from '@/lib/iptv/catalog';
import { encodeSource } from '@/lib/streaming/transcode';

export const dynamic = 'force-dynamic';

/**
 * Resolve an IPTV channel URL (possibly a jmp2.uk shortlink) to a playable
 * proxied manifest. GET /api/iptv/stream?url=...[&name=...]
 *
 * `name` enables per-stream server switching: we look up the same channel on
 * every other source and return them as `alternates`, so the player can offer
 * "also on Plex / Samsung TV+ / Roku …" hopping (and auto-failover) — the
 * IPTV counterpart of the original repo's multi-server stream list.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('url');
  const name = searchParams.get('name') || '';
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return NextResponse.json({ error: 'bad_url' }, { status: 400 });
  }

  // alternates are computed independently of resolution, so they are available
  // even when the primary stream fails (player uses them to fail over)
  const alternates: AlternateChannel[] = name ? await findAlternates(name, raw) : [];

  try {
    const finalUrl = await resolveRedirects(raw);
    return NextResponse.json({
      url: proxyUrlFor(finalUrl, ''),
      directUrl: finalUrl,
      // signed params so the player can request data-saver transcodes of
      // this exact source (240/360/480p ladder)
      tc: encodeSource(finalUrl, ''),
      alternates,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: 'resolve_error',
        message: (e as Error).message,
        alternates,
      },
      { status: 502 }
    );
  }
}
