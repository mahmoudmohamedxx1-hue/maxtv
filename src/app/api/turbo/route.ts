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
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const mirror = searchParams.get('m') || undefined;
  const reqSid = searchParams.get('sid') || '';

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
    // stale session — the turbo cache was replaced while the player still
    // holds old URLs; fail fast so the player hops instead of retrying
    if (reqSid && reqSid !== session.sid) {
      return new NextResponse('stale session', {
        status: 503,
        headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    const n = parseInt(searchParams.get('n') || '', 10);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: 'bad_segment' }, { status: 400 });
    }
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
        // segment ns recycle across sessions — never let a browser cache them
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  // playlist mode
  const session = getTurboSession(channel, mirror);
  session.touch();
  const verdict = await session.waitReady(7_000);

  if (verdict === 'relay') {
    // codec not browser-safe → hand off to the transcode relay (hls.js
    // follows the redirect transparently)
    const m = mirror ? `&m=${encodeURIComponent(mirror)}` : '';
    return NextResponse.redirect(new URL(`/api/live?channel=${channel}${m}&mode=m3u8`, req.url), 302);
  }
  if (verdict === 'dead') {
    return new NextResponse('turbo unavailable — channel may be off-air', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }

  const sid = session.sid;
  const raw = session.readPlaylist();
  if (!raw) {
    return new NextResponse('playlist gone', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }
  // rewrite tN.ts lines → sid-stamped segment URLs through this endpoint
  const segUrlFor = (n: number) => {
    const p = new URLSearchParams(searchParams);
    p.set('mode', 'seg');
    p.set('n', String(n));
    p.set('sid', sid);
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
