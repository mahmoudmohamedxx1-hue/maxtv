import { NextResponse } from 'next/server';
import { resolveDaddyLiveStream, DADDYLIVE_SERVERS } from '@/lib/sports/daddylive';
import { proxyUrlFor } from '@/lib/streaming/proxy';
import { findAlternates, type AlternateChannel } from '@/lib/iptv/catalog';
import { probeLadder, peekLadder } from '@/lib/streaming/ladder';
import { getTurboSession, peekTurboSession } from '@/lib/streaming/turbo';

export const dynamic = 'force-dynamic';

/** serverless hosts freeze between requests — the turbo prefetch relay is the
 *  smooth transport there (inline kick per poll). Self-hosted keeps direct. */
const SERVERLESS = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how many of the best alternates get their quality ladder probed (the
 *  multi-quality rungs shown in the player's quality menu). Pool entries ship
 *  pre-verified rungs and never consume a probe slot. */
const LADDER_PROBE_COUNT = 4;
const LADDER_PROBE_WAIT_MS = 1_800;

/**
 * Resolve a DaddyLive channel id to a playable (proxied) HLS manifest.
 * GET /api/sports/stream?channel=100[&server=direct|edge|turbo|relay|direct-dlive|…][&name=…]
 *
 * Per-stream server switching — transport-based (see daddylive.ts):
 *   • direct (self-hosted default; "Server 2") — the browser proxies the CDN
 *     manifest via /api/hls (no ffmpeg, no relay hop)
 *   • turbo (SERVERLESS default; "Server 1") — /api/turbo prefetch playlist
 *     with the v2 inline kick; the player reads warm bytes and rides out CDN
 *     flaps on a 12-segment runway. Pre-warmed below so it fills while the
 *     player is still setting up hls.js.
 *   • edge — deterministic CDN-edge manifest, lowest resolution latency
 *   • relay — /api/live ffmpeg remux/transcode (bulletproof fallback)
 * Each transport can be pinned to a mirror for (re-)resolution. The response
 * carries the full server list so the player can offer manual switching (and
 * auto-failover) between genuinely different transports.
 *
 * &name= (optional, the channel's display name) additionally resolves
 * `alternates` — the SAME channel carried by other providers (World Sports,
 * beIN, Pluto …). Those sources ship real ABR ladders (multiple qualities:
 * amagi alone serves 240p→1080p), so the top ones are ladder-probed here and
 * their rungs surface in the player's QUALITY menu (the ffmpeg data-saver
 * ladder is dead on serverless — this is the multi-quality engine now).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const channel = searchParams.get('channel');
  const serverParam = searchParams.get('server');
  const server = serverParam || (SERVERLESS ? 'turbo' : 'direct');
  const chName = (searchParams.get('name') || '').slice(0, 80);
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
    // ── start the turbo pre-warm FIRST — it runs in parallel with the resolve
    // and alternates work, and its bounded kick (playlist + first segment)
    // yields the CODEC sniff that tells HEVC-incapable browsers to expect an
    // HEVC phase before they buffer into a codec error (beIN 5 → XTRA bug).
    const mirrorPin = serverDef?.mirror || (isTurbo && server.includes('-') ? server.slice('turbo-'.length) : undefined);
    const turboPrewarm =
      isTurbo || SERVERLESS
        ? getTurboSession(channel, mirrorPin).kick(2_200)
        : null;

    // resolve even for relay mode — verifies the channel exists (fast 404 for
    // dead ids) AND warms the resolve cache so the relay's first pass is instant.
    // Alternates (same channel on ladder-bearing providers) resolve in
    // parallel — they're independent of the primary transport.
    const [resolvedIn, alternates] = await Promise.all([
      resolveDaddyLiveStream(channel, { server }),
      chName ? findAlternates(chName, '') : Promise.resolve([] as AlternateChannel[]),
    ]);
    let resolved = resolvedIn;

    // ── await the pre-warm (usually finished by now — it raced the resolve) ──
    // The session's first cached segment carries the codec verdict, surfaced
    // to the player as `hevc: true` so HEVC-incapable browsers get the
    // explicit choice panel instead of a silent walk onto another channel.
    // ⚠ .catch — a prewarm rejection must NEVER fail the resolve itself.
    let hevcFeed = false;
    if (turboPrewarm) {
      await turboPrewarm.catch(() => {});
      hevcFeed = peekTurboSession(channel, mirrorPin)?.unsafeCodec === true;
    }

    // cold-start mirror flap rescue: every parallel resolve task can fail in
    // the same rate-limit window and return null; one FRESH retry a moment
    // later succeeds. Without it the player surfaces "offline/geo-blocked".
    if (!resolved || !resolved.url) {
      await sleep(600);
      resolved = await resolveDaddyLiveStream(channel, { server, fresh: true });
    }

    // ── ladder-probe the best alternates (multi-quality rungs) ─────────────
    // Bounded: resolve must not crawl when an alternate CDN is slow. Probes
    // continue in the background and land in the cache for the next open.
    // Pool-verified alternates already carry their rungs — no probe needed.
    const origin = new URL(req.url).origin;
    const altTyped = alternates as (AlternateChannel & { ladder?: number[]; cors?: boolean })[];
    const topAlts = altTyped
      .slice(0, LADDER_PROBE_COUNT + 4)
      .filter((a) => /^https?:\/\//i.test(a.url || '') && !a.ladder)
      .slice(0, LADDER_PROBE_COUNT);
    if (topAlts.length) {
      const probes = Promise.allSettled(topAlts.map((a) => probeLadder(a.url, '', origin)));
      await Promise.race([probes, sleep(LADDER_PROBE_WAIT_MS)]);
      for (const a of topAlts) {
        const info = peekLadder(a.url, '');
        if (info && info.heights.length) {
          a.ladder = info.heights;
          a.cors = info.cors;
        }
      }
    }

    if (!resolved || !resolved.url) {
      return NextResponse.json(
        {
          error: 'resolve_failed',
          message: 'No stream found for this channel right now.',
          servers: serverList,
          alternates: altTyped,
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
      alternates: altTyped,
      // the sniffed feed is in an HEVC (browser-unsafe codec) phase — the
      // player checks this against its own decode capability and shows the
      // explicit HEVC panel instead of silently walking onto another channel
      ...(hevcFeed ? { hevc: true } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: 'resolve_error', message: (e as Error).message }, { status: 500 });
  }
}
