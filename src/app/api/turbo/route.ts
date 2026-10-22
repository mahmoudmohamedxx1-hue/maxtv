import { NextResponse, after } from 'next/server';
import { getTurboSession, SEG_LADDER_HEIGHTS, TurboSession } from '@/lib/streaming/turbo';
import { ffmpegCapable, SERVERLESS } from '@/lib/streaming/ffmpeg-cap';
import { setProxyOriginFromRequest } from '@/lib/streaming/upstream';
import { rememberNativeHeight } from '@/lib/streaming/ladder-master';
import { ON_WORKERS, resetSubrequestBudget } from '@/lib/streaming/runtime';

export const dynamic = 'force-dynamic';
/** per-segment transcodes can take up to ~10s (kick + upstream fetch + encode)
 *  — the default 10s function budget is too tight for the &h= ladder */
export const maxDuration = 60;

// ── Workers guards (2026-10-22) ─────────────────────────────────────────────
// The free plan meters REQUESTS (100k/day) and caps subrequests per invocation
// (50). Two cheap isolate-local guards keep strangers from burning the quota:

/** referer/origin gate — a video URL only works for OUR pages. Absent
 *  referer (some browsers/extensions/PWAs strip it) passes; a referer from
 *  ANOTHER host is a third-party embed → 403. hls.js same-origin fetches
 *  always carry the app's own origin. */
function crossSiteEmbed(req: Request): boolean {
  const host = new URL(req.url).host;
  const ref = req.headers.get('referer');
  if (ref) {
    try {
      if (new URL(ref).host !== host) return true;
    } catch {
      /* unparseable referer — treat as absent */
    }
  }
  const org = req.headers.get('origin');
  if (org && org !== 'null') {
    try {
      if (new URL(org).host !== host) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** per-IP token bucket (isolate-local approximation — enough to stop a
 *  runaway client, the platform's own metering remains the real bound).
 *  90 requests / 10s covers a 4-pane multi-view grid with the prefetcher. */
const RL_WINDOW_MS = 10_000;
const RL_MAX = 90;
const rlG = globalThis as { __maxtvRl?: Map<string, { n: number; at: number }> };
if (!rlG.__maxtvRl) rlG.__maxtvRl = new Map();
function rateLimited(req: Request): boolean {
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown';
  const now = Date.now();
  const b = rlG.__maxtvRl!.get(ip);
  if (!b || now - b.at > RL_WINDOW_MS) {
    rlG.__maxtvRl!.set(ip, { n: 1, at: now });
    if (rlG.__maxtvRl!.size > 500) {
      // drop the oldest half (insertion order ≈ age)
      const keys = [...rlG.__maxtvRl!.keys()].slice(0, 250);
      for (const k of keys) rlG.__maxtvRl!.delete(k);
    }
    return false;
  }
  b.n++;
  return b.n > RL_MAX;
}

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
    // 5-deep: the ladder player joins 5 segments back, so the warm band
    // must cover the join position + the segments above it — each segment
    // then gets ~2 polls (≈12s) of encode lead before the playhead arrives
    session.warmTranscodes(h, 5);
  } catch {
    /* best effort */
  }
}

export async function GET(req: Request) {
  // Capture incoming origin so streaming-layer fetches to /api/proxy use the
  // public alias (bypasses Vercel's deployment-URL SSO redirect).
  setProxyOriginFromRequest(req);
  // ⤴ Workers: fresh subrequest budget for this invocation (free plan caps
  //  at 50; the turbo engine trims itself to what remains — see runtime.ts)
  resetSubrequestBudget();
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const mirror = searchParams.get('m') || undefined;

  // ⤴ Workers guards on the two expensive modes only (m3u8 polls + segment
  //  bytes are what a quota thief wants; cap/native probes are cheap)
  if (ON_WORKERS && (mode === 'm3u8' || mode === 'seg')) {
    if (crossSiteEmbed(req)) {
      return new NextResponse('hotlink denied', {
        status: 403,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }
    if (rateLimited(req)) {
      return new NextResponse('slow down', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', 'retry-after': '2' },
      });
    }
  }

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

  // ── native-height probe — the ladder master's Source rung ships without
  // RESOLUTION (single-rendition playlists never declare it), so the quality
  // menu showed a bare "Source" instead of the channel's real 720p/1080p
  // entry. The player fires this once per channel open; the answer relabels
  // the Source menu item AND (per-isolate) teaches buildLadderMaster to embed
  // RESOLUTION, so future masters carry it natively.
  if (mode === 'native') {
    const session = getTurboSession(channel, mirror);
    session.touch();
    const h = await session.nativeHeight(5_500);
    if (h > 0) rememberNativeHeight(channel, h);
    return NextResponse.json(
      { h },
      // browser-cacheable: height is stable for a channel's lifetime — repeat
      // channel opens skip the probe round-trip entirely
      { headers: { 'cache-control': 'public, max-age=1800', 'access-control-allow-origin': '*' } }
    );
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
    // ladder: keep warming the ride band from segment requests too — on
    // Vercel an isolate that ONLY sees segment traffic (playlist polls land
    // on a sibling) would otherwise serve every segment as a cold encode.
    // after() runs post-response: zero added player latency. Throttled to
    // one batch per 2s inside warmTranscodes.
    if (h) after(() => void warmTurboLadder(session, h));
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        // ⤴ 2026-10-22 EDGE-CACHED SEGMENTS: Vercel load-balances /api/turbo
        // across isolates, and only the isolate that ENCODED a rung segment
        // could serve it — cross-isolate requests 404'd after 2-7s of futile
        // work (measured in prod: the ride position itself 404ing was the
        // "stops to load every 3-5s on ANY quality" root cause). With
        // s-maxage the FIRST successful encode parks at Vercel's edge and
        // every later request — any isolate, any viewer — is an instant
        // cache hit. max-age=0 keeps the BROWSER honest (ns recycle across
        // upstream restarts; the &g= generation param keeps the EDGE honest
        // — see the m3u8 rewriter below). 25s covers the ride band's
        // lifetime (~25-30s behind the tip) with margin for recycle safety.
        //
        // ⤴ WORKERS: no shared edge cache by header on workers.dev, and the
        // free plan meters REQUESTS — so flip to BROWSER caching instead:
        // upstream segment URLs are immutable (unique ns), so 45s of
        // max-age lets the client prefetcher's bytes be reused by hls.js's
        // own fragment load — roughly HALVING segment requests. A restart
        // mid-window only risks ≤45s of stale bytes, and the player's
        // micro-gap watchdog absorbs the PTS discontinuity.
        'cache-control': ON_WORKERS
          ? 'public, max-age=45'
          : 'public, max-age=0, s-maxage=25',
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
      // ⚠ distinguish GENUINE death (dead session / definitive resolve
      // failure) from a slow warm-up: a freshly-spawned session on a cold
      // isolate can easily spend its whole 6s budget on the paired
      // token+manifest fetch, and answering THAT with 503+x-offair made
      // the player declare the channel dead and walk channels mid-match
      // (2026-10-21 ladder field test). Only a dead session is off-air;
      // everything else is a retryable warm-up — hls.js re-polls, each poll
      // kicks the session forward, and the stream recovers in place.
      if (session.isDead) {
        return new NextResponse('turbo unavailable — channel may be off-air', {
          status: 503,
          headers: { 'x-offair': '1', 'content-type': 'text/plain', 'cache-control': 'no-store' },
        });
      }
      return new NextResponse('turbo warming up', {
        status: 502,
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
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
      p.set('h', String(h)); // sanitized ladder height — never a dead >480 ask
      p.set('g', String(session.generation)); // edge-cache generation (restart-safe)
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
  // instance-independent, so any warm instance can serve the bytes).
  // ⚠ strip a dead &h= ask (e.g. a stale 720/1080 pref): the sanitized h is
  // 0 here, and echoing the unsanitized param into segment URLs made the
  // native playlist LOOK like it still referenced a transcode ladder.
  const segUrlFor = (n: number) => {
    const p = new URLSearchParams(searchParams);
    p.set('mode', 'seg');
    p.set('n', String(n));
    p.delete('h'); // native passthrough — no ladder height to carry
    p.set('g', String(session.generation)); // edge-cache generation (restart-safe)
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
