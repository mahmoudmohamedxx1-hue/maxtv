import { NextResponse } from 'next/server';
import { resolveDaddyLiveStream, DADDYLIVE_SERVERS } from '@/lib/sports/daddylive';
import { proxyUrlFor } from '@/lib/streaming/proxy';

export const dynamic = 'force-dynamic';

/**
 * Resolve a DaddyLive channel id to a playable (proxied) HLS manifest.
 * GET /api/sports/stream?channel=100[&server=direct|edge|turbo|relay|direct-dlive|…]
 *
 * Per-stream server switching — transport-based (see daddylive.ts):
 *   • direct (DEFAULT, "Server 2") — user-verified best: the browser proxies
 *     the CDN manifest via /api/hls (no ffmpeg, no relay hop)
 *   • edge — deterministic CDN-edge manifest, lowest resolution latency
 *   • turbo — /api/turbo prefetch playlist; server-side cache keeps the
 *     player off the CDN's critical path
 *   • relay — /api/live ffmpeg remux/transcode (bulletproof fallback)
 * Each transport can be pinned to a mirror for (re-)resolution. The response
 * carries the full server list so the player can offer manual switching (and
 * auto-failover) between genuinely different transports.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const channel = searchParams.get('channel');
  const server = searchParams.get('server') || 'direct';
  if (!channel || !/^\d+$/.test(channel)) {
    return NextResponse.json({ error: 'bad_channel' }, { status: 400 });
  }

  const isRelay = server.startsWith('relay');
  const isTurbo = server.startsWith('turbo');
  const isEdge = server === 'edge' || server.startsWith('edge-');
  const SERVER_LIST = DADDYLIVE_SERVERS as readonly {
    id: string;
    label: string;
    host: string;
    path: string;
    mirror?: string;
  }[];
  const serverDef = SERVER_LIST.find((s) => s.id === server);
  const serverList = SERVER_LIST.map((s) => ({
    id: s.id,
    label: s.label,
    host: s.host,
    path: s.path,
    ...(s.mirror ? { mirror: s.mirror } : {}),
  }));

  try {
    // resolve even for relay mode — verifies the channel exists (fast 404 for
    // dead ids) AND warms the resolve cache so the relay's first pass is instant
    const resolved = await resolveDaddyLiveStream(channel, { server });
    if (!resolved || !resolved.url) {
      return NextResponse.json(
        {
          error: 'resolve_failed',
          message: 'No stream found for this channel right now.',
          servers: serverList,
        },
        { status: 404 }
      );
    }

    // transport: turbo serves a local, prefetch-cached playlist (no ffmpeg —
    // sessions spawn on the player's first /api/turbo hit so hover-prefetch
    // stays cheap); relay serves the ffmpeg remux through /api/live; direct
    // proxies the CDN manifest through /api/hls.
    const mirrorParam = serverDef?.mirror ? `&m=${serverDef.mirror}` : '';
    let url: string;
    if (isTurbo) {
      url = `/api/turbo?channel=${encodeURIComponent(channel)}${mirrorParam}&mode=m3u8`;
    } else if (isRelay) {
      url = `/api/live?channel=${encodeURIComponent(channel)}${mirrorParam}&mode=m3u8`;
    } else {
      // direct + edge: proxy the resolved manifest through /api/hls. The
      // edge pin makes resolveDaddyLiveStream return the deterministic
      // edge URL (premium{id}/index.m3u8) — same transport, faster resolve.
      // &ch/&srv give /api/hls session-affinity recovery context: when the
      // CDN 403s a refresh (serverless IP rotation) it re-resolves fresh.
      url =
        proxyUrlFor(resolved.url, resolved.referer || '') +
        `&ch=${encodeURIComponent(channel)}&srv=${encodeURIComponent(server)}`;
    }

    const defaultId = isTurbo ? 'turbo' : isRelay ? 'relay' : isEdge ? 'edge' : 'direct';
    return NextResponse.json({
      channel,
      url,
      transport: isTurbo ? 'turbo' : isRelay ? 'relay' : isEdge ? 'edge' : 'direct',
      directUrl: resolved.url,
      referer: resolved.referer || undefined,
      strategy: resolved.strategy,
      server: resolved.server,
      serverId: serverDef?.id || defaultId,
      servers: serverList.map((s) => ({ ...s, active: s.id === (serverDef?.id || defaultId) })),
    });
  } catch (e) {
    return NextResponse.json({ error: 'resolve_error', message: (e as Error).message }, { status: 500 });
  }
}
