// Minimal test route — fetches dembed.st page and returns it AS-IS (no processing)
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
  const res = await fetch('https://dembed.st/premiumtv/daddy.php?id=91', {
    headers: { 'User-Agent': UA, 'Referer': 'https://dlive.sx/' },
    signal: AbortSignal.timeout(15_000),
  });
  const html = await res.text();
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-orig-size': String(html.length),
      'x-orig-status': String(res.status),
    },
  });
}
