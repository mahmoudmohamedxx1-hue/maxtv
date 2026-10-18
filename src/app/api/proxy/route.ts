// Edge proxy — runs on Vercel's edge network (Cloudflare's IPs),
// which is different from the serverless functions (AWS IPs).
// The DaddyLive CDN edge blocks AWS IPs (403) but NOT Cloudflare IPs.
export const runtime = 'edge';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const referer = searchParams.get('referer');

  if (!target) {
    return new Response('Missing url param', { status: 400 });
  }

  try {
    const headers: HeadersInit = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (referer) headers['Referer'] = referer;

    const res = await fetch(target, { headers, redirect: 'follow' });
    const body = await res.arrayBuffer();

    return new Response(body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(`Proxy error: ${(e as Error).message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' },
    });
  }
}
