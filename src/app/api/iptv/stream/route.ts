import { NextResponse } from 'next/server';
import { resolveRedirects } from '@/lib/streaming/resolve';
import { proxyUrlFor } from '@/lib/streaming/proxy';
import { findAlternates, type AlternateChannel } from '@/lib/iptv/catalog';
import { encodeSource } from '@/lib/streaming/transcode';
import { probeLadder, peekLadder } from '@/lib/streaming/ladder';

export const dynamic = 'force-dynamic';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROBE_WAIT_MS = 1_800;

/**
 * Resolve an IPTV channel URL (possibly a jmp2.uk shortlink) to a playable
 * manifest. GET /api/iptv/stream?url=...[&name=...]
 *
 * `name` enables per-stream server switching: we look up the same channel on
 * every other source and return them as `alternates`, so the player can offer
 * "also on Plex / Samsung TV+ / Roku …" hopping (and auto-failover) — the
 * IPTV counterpart of the original repo's multi-server stream list.
 *
 * 2026-10-01 — ladder + CORS probe (the freestream-tv play pattern):
 *   • `ladder` — the source's native quality rungs (1080/720/480/…), parsed
 *     from its master playlist, so the quality menu can show real rungs.
 *   • CORS-open CDNs (wurl, some others) get `url` = the DIRECT CDN link —
 *     the browser plays it straight from the CDN with native ABR and zero
 *     proxy latency. `proxied` is always returned as the fallback the player
 *     swaps to if the direct manifest/segments fail.
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
    const proxied = proxyUrlFor(finalUrl, '');

    // ladder + CORS posture (bounded — the probe continues in background and
    // lands in the cache for the next open of this channel)
    const origin = new URL(req.url).origin;
    const probe = probeLadder(finalUrl, '', origin);
    await Promise.race([probe, sleep(PROBE_WAIT_MS)]);
    const info = peekLadder(finalUrl, '');
    const cors = info?.cors === true;

    // direct CDN playback when the CDN answers CORS (zero proxy latency,
    // native ABR); the proxy path otherwise (Referer/anti-CORS shield).
    // ⚠ https-only: an http:// manifest would be mixed-content-blocked on the
    // https page — those sources always play through the same-origin proxy.
    const canDirect = cors && finalUrl.startsWith('https://');
    return NextResponse.json({
      url: canDirect ? finalUrl : proxied,
      directUrl: finalUrl,
      proxied,
      cors,
      ladder: info?.heights || [],
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
