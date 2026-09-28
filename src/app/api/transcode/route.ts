import { NextResponse } from 'next/server';
import {
  getChannelSession,
  getSourceSession,
  findChannelSession,
  findSourceSession,
  decodeSource,
  transcodeCapable,
  TRANSCODE_HEIGHTS,
  type TranscodeHeight,
} from '@/lib/streaming/transcode';

export const dynamic = 'force-dynamic';

/**
 * Transcode quality ladder — real rungs at every height (144p → 1080p) for
 * single-rendition streams (DaddyLive + most free IPTV CDNs).
 *
 * GET /api/transcode?channel=573&height=480&mode=m3u8       → HLS playlist
 * GET /api/transcode?channel=573&height=480&mode=seg&n=17   → segment bytes
 * GET /api/transcode?src=…&r=…&s=…&height=…&mode=…          → same, arbitrary
 *                                                          signed direct source
 *
 * The playlist wait-blocks until ffmpeg has produced its first window
 * (≤ 20s) so hls.js can attach immediately without retry storms.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const heightRaw = parseInt(searchParams.get('height') || '', 10);
  const mode = searchParams.get('mode') || 'm3u8';
  const channel = searchParams.get('channel');
  const src = searchParams.get('src');

  // capability probe — lets the client know whether the data-saver ladder
  // exists on this deployment (serverless hosts ship no ffmpeg → false)
  if (mode === 'cap') {
    return NextResponse.json(
      { cap: await transcodeCapable() },
      { headers: { 'cache-control': 'no-store' } }
    );
  }

  if (!TRANSCODE_HEIGHTS.includes(heightRaw as TranscodeHeight)) {
    return NextResponse.json({ error: 'bad_height', allowed: TRANSCODE_HEIGHTS }, { status: 400 });
  }
  const height = heightRaw as TranscodeHeight;

  // no ffmpeg on this host → fail FAST (no session spawn, no 20s wait) so a
  // fail-open client bounces back to the native feed in milliseconds
  if (mode !== 'probe' && !(await transcodeCapable())) {
    return new NextResponse('transcoding unavailable on this deployment', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain' },
    });
  }

  // probe mode — report the upstream source's real height WITHOUT creating a
  // session (the player uses it to never request a rung above the source).
  // Peeks at the LIVE session for this exact rung; 0 when there is nothing
  // to learn from yet.
  if (mode === 'probe') {
    const peek =
      channel && /^\d+$/.test(channel)
        ? findChannelSession(channel, height)
        : src
          ? (() => {
              const d = decodeSource(src, searchParams.get('r') || '', searchParams.get('s') || '');
              return d ? findSourceSession(d.url, d.referer, height) : null;
            })()
          : null;
    const sourceHeight = peek ? await peek.waitAndProbeSourceHeight(6000) : 0;
    return NextResponse.json(
      { sourceHeight },
      { headers: { 'cache-control': 'no-store' } }
    );
  }

  let session;
  if (channel && /^\d+$/.test(channel)) {
    session = getChannelSession(channel, height);
  } else if (src) {
    const decoded = decodeSource(src, searchParams.get('r') || '', searchParams.get('s') || '');
    if (!decoded) return NextResponse.json({ error: 'bad_source' }, { status: 400 });
    session = getSourceSession(decoded.url, decoded.referer, height);
  } else {
    return NextResponse.json({ error: 'bad_params' }, { status: 400 });
  }

  session.touch();

  if (mode === 'seg') {
    const n = parseInt(searchParams.get('n') || '', 10);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'bad_segment' }, { status: 400 });
    }
    const bytes = await session.readSegment(n);
    if (!bytes) {
      return new NextResponse('segment gone', {
        status: 503,
        headers: { 'x-offair': '1', 'content-type': 'text/plain' },
      });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*',
      },
    });
  }

  // playlist mode — wait for the ffmpeg warmup (bounded)
  const ok = await Promise.race([
    session.ready,
    new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
  ]);
  if (!ok) {
    return new NextResponse('transcode unavailable — channel may be off-air', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain' },
    });
  }
  const text = await session.readPlaylist();
  if (!text) {
    return new NextResponse('playlist gone', {
      status: 503,
      headers: { 'x-offair': '1', 'content-type': 'text/plain' },
    });
  }

  // rewrite segment URIs to route back through this endpoint
  const base = new URL(req.url);
  const segParams = (n: number) => {
    const p = new URLSearchParams(base.searchParams);
    p.set('mode', 'seg');
    p.set('n', String(n));
    return `/api/transcode?${p.toString()}`;
  };
  const rewritten = text
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^seg(\d+)\.ts$/);
      return m ? segParams(parseInt(m[1], 10)) : line;
    })
    .join('\n');

  return new NextResponse(rewritten, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
