// ─── URL resolution: jmp2.uk shortlinks + template cleanup ──────────────────
// IPTV-Scraper-Zilla playlists route many channels through the jmp2.uk
// redirect service. The player needs the final manifest URL, and some
// targets carry device template placeholders ({PSID}, [DEVICE_ID] ...) that
// must be substituted before the CDN accepts the request.

import crypto from 'crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/** Default substitutions for device template placeholders */
const TEMPLATE_DEFAULTS: Array<[RegExp, string]> = [
  [/\{PSID\}|%7BPSID%7D/gi, '9f8e7d6c5b4a3210f0e1'],
  [/\{TARGETOPT\}|%7BTARGETOPT%7D/gi, '0'],
  [/\{US_PRIVACY\}|%7BUS_PRIVACY%7D/gi, '1---'],
  [/\{APP_DOMAIN\}|%7BAPP_DOMAIN%7D/gi, 'pluto.tv'],
  [/\{APP_NAME\}|%7BAPP_NAME%7D/gi, 'web'],
  [/\{TC_STRING\}|%7BTC_STRING%7D/gi, ''],
  [/\{DEVICE_ID\}/gi, '9f8e7d6c5b4a3210f0e1'],
  [/\{IFA\}/gi, ''],
  [/\{IFA_TYPE\}/gi, ''],
  [/\{LMT\}/gi, '0'],
  [/\{DNS\}/gi, '0'],
  [/\{UA\}/gi, encodeURIComponent(UA).slice(0, 40)],
  [/\{IP\}/gi, ''],
  [/\{GDPR\}/gi, '0'],
  [/\{GDPR_CONSENT\}|%7BGDPR_CONSENT%7D/gi, ''],
  [/\{COUNTRY\}/gi, 'US'],
  [/\{US_PRIVACY\}/gi, '1---'],
  [/\[DEVICE_ID\]/gi, '9f8e7d6c5b4a3210f0e1'],
  [/\[IFA\]/gi, ''],
  [/\[IFA_TYPE\]/gi, ''],
  [/\[LMT\]/gi, '0'],
  [/\[DNS\]/gi, '0'],
  [/\[UA\]/gi, ''],
  [/\[IP\]/gi, ''],
  [/\[GDPR\]/gi, '0'],
  [/\[GDPR_CONSENT\]/gi, ''],
  [/\[COUNTRY\]/gi, 'US'],
  [/\[US_PRIVACY\]/gi, '1---'],
  [/\[APP_STOREURL\]/gi, ''],
  [/\[APP_BUNDLE\]/gi, ''],
  [/\[APP_NAME\]/gi, ''],
  [/\[APP_VERSION\]/gi, '1.0.0'],
  [/\[DEVICE_TYPE\]/gi, '3'],
  [/\[DEVICE_MAKE\]/gi, 'chrome'],
  [/\[DEVICE_MODEL\]/gi, 'web'],
  [/\[TARGETAD_ALLOWED\]/gi, ''],
];

export function cleanTemplateParams(url: string): string {
  let out = url;
  for (const [re, val] of TEMPLATE_DEFAULTS) out = out.replace(re, val);
  // collapse empty params like "&x=&" — some CDNs choke on them
  out = out.replace(/([?&])[a-zA-Z0-9_.]+=&/g, '$1');
  return out;
}

const redirectCache = new Map<string, { url: string; expires: number }>();

/** Follow jmp2.uk-style redirects (up to 4 hops) to the final manifest URL */
export async function resolveRedirects(url: string): Promise<string> {
  if (!/jmp2\.uk|jmp\d?\.|tinyurl|bit\.ly/i.test(url)) return cleanTemplateParams(url);

  const hit = redirectCache.get(url);
  if (hit && Date.now() < hit.expires) return hit.url;

  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: AbortSignal.timeout(8000),
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    } catch {
      break;
    }
  }
  const final = cleanTemplateParams(current);
  redirectCache.set(url, { url: final, expires: Date.now() + 10 * 60_000 });
  return final;
}

// ─── SSRF guard (simplified from live-sport-plugin OutboundUrlGuard) ────────
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /\.internal$/i,
  /\.local$/i,
];

export function isBlockedHost(hostname: string): boolean {
  if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname))) return true;
  // also block hex / decimal ip forms
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true;
  if (/^\d{8,10}$/.test(hostname)) return true;
  return false;
}

// ─── URL signing (prevents the /api/hls endpoint becoming an open proxy) ────
// The secret must survive dev-server hot reloads (module re-evaluation),
// so it is cached on globalThis. Set HLS_SIGN_SECRET to persist across
// restarts / multiple instances.
const g = globalThis as { __zillaHlsSecret?: string };
if (!g.__zillaHlsSecret) {
  g.__zillaHlsSecret = process.env.HLS_SIGN_SECRET || crypto.randomBytes(24).toString('hex');
}
const SECRET = g.__zillaHlsSecret;

export function signUrl(url: string, referer: string): string {
  return crypto.createHmac('sha256', SECRET).update(`${url}|${referer}`).digest('base64url').slice(0, 32);
}

export function verifySignature(url: string, referer: string, sig: string): boolean {
  const expected = signUrl(url, referer);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}
