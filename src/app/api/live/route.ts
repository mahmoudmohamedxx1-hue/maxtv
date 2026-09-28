import { NextResponse } from 'next/server';
import { getChannelSession, getSourceSession, decodeSource } from '@/lib/streaming/transcode';

export const dynamic = 'force-dynamic';

/**
 * Live relay endpoint — flap-proof playback for DaddyLive channels.
 *
 *   GET /api/live?channel=91&sid=…&m=dlive&mode=m3u8   → local HLS playlist
 *   GET /api/live?channel=91&sid=…&mode=seg&n=17       → segment bytes
 *   GET /api/live?src=…&r=…&s=…&mode=…               → same, arbitrary signed
 *                                                      direct source (IPTV)
 *
 * Transport: a server-side ffmpeg REMUX session (stream-copy, original
 * quality). The input side re-fetches segments with CDN-flap retries and
 * re-resolution through the mirrors; ffmpeg rebases the timeline so the
 * served playlist is always self-consistent (monotonic timestamps, proper
 * discontinuities) — the browser never sees an upstream PTS pathology.
 *
 * `sid` is the session id — every served URL carries it so browser caches can
 * never serve a previous session's segments. mode=m3u8 wait-blocks until the
 * remux produced its first window (≤ 14s) so hls.js attaches immediately.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const mirror = searchParams.get('m') || undefined;
  const src = searchParams.get('src');
  const reqSid = searchParams.get('sid') || '';

  let session;
  if (channel && /^\d+$/.test(channel)) {
    session = getChannelSession(channel, 0, mirror); // height 0 = remux
  } else if (src) {
    const decoded = decodeSource(src, searchParams.get('r') || '', searchParams.get('s') || '');
    if (!decoded) return NextResponse.json({ error: 'bad_source' }, { status: 400 });
    session = getSourceSession(decoded.url, decoded.referer, 0);
  } else {
    return NextResponse.json({ error: 'bad_params' }, { status: 400 });
  }

  session.touch();

  if (mode === 'seg') {
    // stale session — the relay was replaced while the player still holds old
    // URLs. 503 + x-offair makes the player hop immediately (auto-advance)
    // instead of burning a 45s fragment-retry storm on an obsolete timeline.
    if (reqSid && reqSid !== session.sid) {
      return new NextResponse('stale session', {
        status: 503,
        headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    const n = parseInt(searchParams.get('n') || '', 10);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'bad_segment' }, { status: 400 });
    }
    const bytes = await session.readSegment(n);
    if (!bytes) {
      // 404 (not 503) so hls.js treats it as a recoverable fragment error and
      // reloads the playlist instead of declaring the channel off-air
      return new NextResponse('segment gone', {
        status: 404,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        // no-store: segment urls recycle their n numbering across sessions —
        // caching them let browsers serve a PREVIOUS session's content
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  // playlist mode — bounded warmup wait for ffmpeg's first output
  const ok = await Promise.race([
    session.ready,
    new Promise<boolean>((r) => setTimeout(() => r(false), 14_000)),
  ]);
  if (!ok) {
    return new NextResponse('relay unavailable — channel may be off-air', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  const sid = session.sid;
  const raw = await session.readPlaylist();
  if (!raw) {
    return new NextResponse('playlist gone', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  // rewrite ffmpeg's segNNNNN.ts lines to route back through this endpoint
  const segUrlFor = (n: number) => {
    const p = new URLSearchParams(searchParams);
    p.set('mode', 'seg');
    p.set('n', String(n));
    p.set('sid', sid);
    return `/api/live?${p.toString()}`;
  };
  const text = raw
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^seg(\d+)\.ts$/);
      return m ? segUrlFor(parseInt(m[1], 10)) : line;
    })
    .join('\n');

  return new NextResponse(text, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
