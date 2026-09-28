// ─── /api/hls — the HLS proxy endpoint ──────────────────────────────────────
// Signed via ?s= HMAC. Every manifest rewrite routes segment/variant/keys
// back through this same endpoint, so the browser only ever talks to us.

import { proxyHlsRequest } from '@/lib/streaming/proxy';
import { verifySignature } from '@/lib/streaming/resolve';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const referer = searchParams.get('r') || '';
  const sig = searchParams.get('s') || '';

  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response('bad url', { status: 400 });
  }

  // Signature check — except cleanTemplateParams-safe duplicates
  if (!verifySignature(target, referer, sig)) {
    return new Response('bad signature', { status: 403 });
  }

  try {
    const range = req.headers.get('range') || undefined;
    const result = await proxyHlsRequest(target, referer, range);

    const headers = new Headers(result.headers);
    if (result.bodyBytes !== undefined) {
      return new Response(result.bodyBytes as unknown as BodyInit, { status: result.status, headers });
    }
    if (result.body !== undefined) {
      return new Response(result.body, { status: result.status, headers });
    }
    if (result.stream) {
      return new Response(result.stream, { status: result.status, headers });
    }
    return new Response('empty', { status: 502, headers });
  } catch (e) {
    const msg = (e as Error).message || 'proxy error';
    const status = /timeout|abort/i.test(msg) ? 504 : 502;
    return new Response(`proxy error: ${msg}`, { status });
  }
}

export async function HEAD(req: Request) {
  const res = await GET(req);
  return new Response(null, { status: res.status, headers: res.headers });
}
