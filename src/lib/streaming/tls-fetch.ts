// ─── TLS-tolerant upstream fetch ─────────────────────────────────────────────
// Free-IPTV upstreams rot fast, and one of the most common rot modes is a
// forgotten TLS certificate (CGTN's caton.cloud CDN — 8+ channels — shipped an
// expired cert for 5+ weeks in 2026). Node's global fetch hard-fails those
// with "fetch failed", and on serverless deployments (no ffmpeg to mask it)
// every channel behind an expired-cert CDN reads as dead.
//
// Strategy: STRICT verification first. If — and only if — the failure is a
// certificate *validation* error, retry once with verification disabled via
// the core node http(s) module. DNS failures, timeouts, resets and 4xx/5xx
// are never retried loosely. This mirrors what VLC/mpv do (play the stream,
// warn about the cert) and only ever affects public video manifests and
// segments — no credentials are sent to IPTV CDNs.

import http from 'http';
import https from 'https';

/** OpenSSL/undici error codes that mean "the certificate could not be trusted",
 *  as opposed to network-level failures. */
const CERT_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED_EXT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_CHAIN_INCOMPLETE',
  'CERT_SIGNATURE_FAILURE',
  'EPROTO', // some CDNs misconfigure mid-handshake; curl -k plays them
]);

/** walk the error's cause chain looking for a TLS/cert failure code */
export function isCertError(e: unknown): boolean {
  let cur = e as { cause?: unknown; code?: string } | null | undefined;
  for (let i = 0; cur && i < 5; i++) {
    const code = (cur as { code?: string }).code || '';
    if (typeof code === 'string' && CERT_ERROR_CODES.has(code)) return true;
    // undici wraps as TypeError('fetch failed') { cause: Error { code } }
    cur = (cur as { cause?: { code?: string; cause?: unknown } }).cause ?? null;
  }
  // last resort: message sniff (undici sometimes flattens the cause)
  const msg = e instanceof Error ? `${e.message} ${(e as Error & { cause?: Error }).cause?.message ?? ''}` : String(e);
  return /certificate|tls|ssl/i.test(msg) && /expired|invalid|self-?signed|verify|unable|untrusted/i.test(msg);
}

/** subset of fetch's Response surface the streaming engine uses */
export interface FetchLike {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
}

/** node-core fetch with rejectUnauthorized:false, manual redirect following */
function relaxedGet(
  urlStr: string,
  headers: Record<string, string>,
  timeoutMs: number,
  depth = 0
): Promise<FetchLike> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error('bad url'));
      return;
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      {
        method: 'GET',
        rejectUnauthorized: false,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        // follow redirects ourselves (no fetch machinery to do it for us)
        if ([301, 302, 303, 307, 308].includes(status) && loc && depth < 6) {
          res.resume(); // drain
          relaxedGet(new URL(loc, u).toString(), headers, timeoutMs, depth + 1).then(resolve, reject);
          return;
        }
        // single-consumption web stream over the node stream; text() and
        // arrayBuffer() read through it so exactly one party drains the socket
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            res.on('data', (d: Buffer) => c.enqueue(new Uint8Array(d)));
            res.on('end', () => {
              try {
                c.close();
              } catch {
                /* already closed */
              }
            });
            res.on('error', (e) => c.error(e));
          },
          cancel(reason) {
            res.destroy(reason as Error);
          },
        });
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') flat[k] = v;
          else if (Array.isArray(v)) flat[k] = v.join(', ');
        }
        const readAll = async (): Promise<Uint8Array> => {
          const reader = stream.getReader();
          const parts: Uint8Array[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) parts.push(value);
          }
          const total = parts.reduce((n, p) => n + p.length, 0);
          const buf = new Uint8Array(total);
          let o = 0;
          for (const p of parts) {
            buf.set(p, o);
            o += p.length;
          }
          return buf;
        };
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url: urlStr, // this recursion level IS the final hop
          headers: { get: (n: string) => flat[n.toLowerCase()] ?? null },
          text: async () => new TextDecoder().decode(await readAll()),
          arrayBuffer: async () => {
            const buf = await readAll();
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
          },
          body: stream,
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Strict fetch first; on a certificate-validation failure retry once with
 * verification disabled. `init` mirrors the small option surface the
 * streaming engine uses (headers + timeout).
 */
export async function fetchTolerant(
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<FetchLike> {
  const timeoutMs = init.timeoutMs ?? 20_000;
  const headers = init.headers ?? {};
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // adapt the native Response to FetchLike (url is exposed natively)
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      headers: { get: (n: string) => res.headers.get(n) },
      text: () => res.text(),
      arrayBuffer: async () => {
        const b = await res.arrayBuffer();
        return b;
      },
      body: res.body as ReadableStream<Uint8Array> | null,
    };
  } catch (e) {
    if (isCertError(e)) {
      return relaxedGet(url, headers, timeoutMs);
    }
    throw e;
  }
}
