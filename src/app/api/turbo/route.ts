import { NextResponse } from 'next/server';
import { getTurboSession, peekTurboSession } from '@/lib/streaming/turbo';

export const dynamic = 'force-dynamic';

/**
 * Turbo transport endpoint — prefetch passthrough for DaddyLive channels.
 *
 *   GET /api/turbo?channel=91[&m=dlive]&mode=m3u8   → local HLS playlist
 *   GET /api/turbo?…&mode=seg&n=17&sid=…            → cached segment bytes
 *
 * A server-side poller prefetches segments ahead of the client, so the
 * browser only ever reads warm local bytes — no ffmpeg, no warmup wait, no
 * CPU war, and CDN flaps are absorbed by the prefetch cache instead of
 * stalling the player. When the source's codec is not browser-safe (hevc /
 * AC3 …) the playlist request 302-redirects to the transcode relay
 * (/api/live), which re-encodes to uniform h264.
 *
 * v2 (serverless-proof): every playlist request awaits one inline polling
 * pass (the "kick") before serving, so the session advances on the player's
 * own poll cadence even when the isolate froze between requests. Segments
 * are numbered in the UPSTREAM media-sequence space, so instance hops don't
 * reset the playlist identity.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const mirror = searchParams.get('m') || undefined;

  if (!channel || !/^\d+$/.test(channel)) {
    return NextResponse.json({ error: 'bad_channel' }, { status: 400 });
  }

  if (mode === 'seg') {
    // never spawn sessions on segment hits
    const session = peekTurboSession(channel, mirror);
    if (!session) {
      return new NextResponse('session gone', {
        status: 404,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    session.touch();
    const n = parseInt(searchParams.get('n') || '', 10);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: 'bad_segment' }, { status: 400 });
    }
    // ⤴ v2: n is the UPSTREAM sn — any warm instance can serve it, and a
    // cache miss triggers an on-demand upstream fetch inside getSegment
    // (cross-instance tolerance) instead of a stale-session 503.
    const bytes = await session.getSegment(n);
    if (!bytes) {
      // 404 → hls.js treats it as a recoverable fragment error and reloads
      return new NextResponse('segment gone', {
        status: 404,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        // segment ns recycle across restarts — never let a browser cache them
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  // playlist mode
  const session = getTurboSession(channel, mirror);
  session.touch();
  // ⤴ v2 INLINE KICK — advance the prefetch NOW (bounded), then wait for a
  // servable window. On serverless this is what keeps the session alive and
  // moving: the playlist poll itself drives the work.
  await session.kick(2_500);
  const verdict = await session.waitReady(6_000);

  if (verdict === 'relay') {
    // codec not browser-safe → hand off to the transcode relay (hls.js
    // follows the redirect transparently)
    const m = mirror ? `&m=${encodeURIComponent(mirror)}` : '';
    return NextResponse.redirect(new URL(`/api/live?channel=${channel}${m}&mode=m3u8`, req.url), 302);
  }
  if (verdict === 'dead') {
    // honest death (upstream stalled / resolve failed) → the reserved 503
    // x-offair so the player skips straight to the off-air screen. A mere
    // warm-up timeout → 502 retryable: hls.js re-polls, each poll KICKS the
    // session again, and a slow-starting channel recovers on a retry instead
    // of being wrongly declared dead.
    const dead = session.isDead;
    return new NextResponse(dead ? 'turbo unavailable — channel may be off-air' : 'turbo warming up', {
      status: dead ? 503 : 502,
      headers: {
        ...(dead ? { 'x-offair': '1' } : {}),
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      },
    });
  }

  const raw = session.readPlaylist();
  if (!raw) {
    return new NextResponse('playlist gone', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  // rewrite t<sn>.ts lines → /api/turbo segment URLs (n = upstream sn —
  // instance-independent, so any warm instance can serve the bytes)
  const segUrlFor = (n: number) => {
    const p = new URLSearchParams(searchParams);
    p.set('mode', 'seg');
    p.set('n', String(n));
    return `/api/turbo?${p.toString()}`;
  };
  const text = raw
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^t(\d+)\.ts$/);
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
