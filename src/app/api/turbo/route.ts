import { NextResponse, after } from 'next/server';
import { getTurboSession, SEG_LADDER_HEIGHTS, TurboSession } from '@/lib/streaming/turbo';
import { ffmpegCapable, SERVERLESS } from '@/lib/streaming/ffmpeg-cap';

export const dynamic = 'force-dynamic';
/** per-segment transcodes can take up to ~10s (kick + upstream fetch + encode)
 *  — the default 10s function budget is too tight for the &h= ladder */
export const maxDuration = 60;

/**
 * Turbo transport endpoint — prefetch passthrough for DaddyLive channels.
 *
 *   GET /api/turbo?channel=91[&m=dlive]&mode=m3u8   → local HLS playlist
 *   GET /api/turbo?…&mode=seg&n=17&sid=…            → cached segment bytes
 *   GET /api/turbo?channel=91&h=480&mode=m3u8       → data-saver playlist
 *   GET /api/turbo?channel=91&h=480&mode=seg&n=17   → re-encoded segment
 *   GET /api/turbo?mode=cap                          → capability probe
 *
 * A server-side poller prefetches segments ahead of the client, so the
 * browser only ever reads warm local bytes. When the source's codec is not
 * browser-safe (hevc / AC3 …) AND the continuous relay exists (self-hosted),
 * the playlist request 302-redirects to /api/live. On serverless a
 * from-the-start HEVC feed is served through instead — Safari/Chrome-with-HEVC
 * play it natively and incapable browsers get the player's explicit choice
 * panel, which now also offers the &h= conversion ladder ("Play at 480p").
 *
 * &h=<height> — the SERVERLESS DATA-SAVER LADDER: every segment is re-encoded
 * one-shot (bundled static ffmpeg, x264 veryfast) to clean h264+AAC at the
 * requested height. This is real quality switching for single-rendition
 * sources (every DaddyLive channel incl. the beIN family) on hosts where no
 * continuous transcoder can exist — and it converts HEVC feeds to a codec any
 * browser can play.
 */
/** after()-callback: advance the session once more, then warm the ladder.
 *  Bounded (≤20s of transcode work) so one invocation can't run away. */
async function warmTurboLadder(session: TurboSession, h: number): Promise<void> {
  try {
    await session.kick(2_000);
    session.warmTranscodes(h, 3);
  } catch {
    /* best effort */
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const mirror = searchParams.get('m') || undefined;

  // capability probe — the player asks once per page load whether the
  // data-saver ladder exists on this deployment:
  //   cap = continuous /api/live relay (self-hosted PATH ffmpeg)
  //   seg = per-segment &h= ladder (bundled static binary — works on Vercel)
  if (mode === 'cap') {
    const ok = await ffmpegCapable(); // probes the bundled binary, else PATH
    return NextResponse.json(
      { cap: !SERVERLESS && ok, seg: ok },
      { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } }
    );
  }

  if (!channel || !/^\d+$/.test(channel)) {
    return NextResponse.json({ error: 'bad_channel' }, { status: 400 });
  }

  const hRaw = parseInt(searchParams.get('h') || '', 10);
  const h = (SEG_LADDER_HEIGHTS as readonly number[]).includes(hRaw) ? hRaw : 0;

  if (mode === 'seg') {
    // ⤴ v3: segment hits CREATE the session when this instance doesn't have
    // it (Vercel load-balances /api/turbo requests across instances — a
    // segment URL minted by instance A used to hard-404 as 'session gone' on
    // instance B, burning hls.js's retry budget until the channel died).
    // getSegment's on-demand path (kick + urlBySn + direct upstream fetch)
    // makes any instance able to serve any recent segment. Hover-prefetch
    // never touches this route (it only resolves JSON), so the spawn cost is
    // only ever paid during real playback.
    const session = getTurboSession(channel, mirror);
    session.touch();
    const n = parseInt(searchParams.get('n') || '', 10);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: 'bad_segment' }, { status: 400 });
    }
    // ⤴ v2: n is the UPSTREAM sn — any warm instance can serve it, and a
    // cache miss triggers an on-demand upstream fetch inside getSegment
    // (cross-instance tolerance) instead of a stale-session 503.
    const bytes = h
      ? await session.getTranscodedSegment(n, h)
      : await session.getSegment(n);
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

  // settle the ffmpeg probe first (ms-fast) so the relay-vs-serve decision
  // for browser-unsafe (HEVC) feeds is made on fact, not on the probe's
  // serverless-safe default
  await ffmpegCapable();
  const session = getTurboSession(channel, mirror);
  session.touch();

  // ── data-saver ladder playlist: codec safety is irrelevant (segments get
  // re-encoded), so an HEVC feed is directly usable at &h=
  if (h) {
    await session.kick(2_500);
    const ok = await session.waitReadyTC(6_000);
    const raw = ok ? session.readPlaylist(h) : null;
    if (!raw) {
      return new NextResponse('turbo unavailable — channel may be off-air', {
        status: 503,
        headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    // warm the window's segments AFTER the response — `after()` keeps this
    // invocation alive on serverless, so the transcodes actually finish and
    // the player's segment requests (arriving right behind this poll) hit
    // warm bytes instead of paying the ~5-15s cold encode per segment.
    after(() => void warmTurboLadder(session, h));
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

  // ⤴ v2 INLINE KICK — advance the prefetch NOW (bounded), then wait for a
  // servable window. On serverless this is what keeps the session alive and
  // moving: the playlist poll itself drives the work.
  await session.kick(2_500);
  const verdict = await session.waitReady(6_000);

  if (verdict === 'relay') {
    // codec not browser-safe → hand off to the transcode relay (hls.js
    // follows the redirect transparently). Only reachable self-hosted —
    // serverless serves unsafe feeds through instead.
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
