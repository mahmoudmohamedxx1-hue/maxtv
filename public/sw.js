/* ─── MaxTV service worker ────────────────────────────────────────────────────
 * Deliberately MINIMAL: MaxTV is a live-streaming app — playlists, segments
 * and every /api/* call must ALWAYS hit the network (caching a live playlist
 * past its window kills playback in any browser that honors the SW). What the
 * SW provides is installability + an offline-friendly app shell:
 *
 *   • navigations  → network-first, fall back to the cached shell (offline
 *                    shows the app chrome instantly instead of a browser dino)
 *   • static build assets (/_next/static/…) + brand icons → cache-first
 *                    (immutable, hashed — safe forever)
 *   • everything else (all /api/*, .m3u8, .ts, .mp4, xhr streams) → passthrough
 *
 * Bump SW_VERSION to invalidate old caches on deploy.
 */

const SW_VERSION = 'maxtv-v1';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const STATIC_CACHE = `${SW_VERSION}-static`;

const SHELL_URL = '/';
const STATIC_ASSETS = [
  '/maxtv-logo.png',
  '/maxtv-mark.png',
  '/maxtv-icon-192.png',
  '/maxtv-icon-512.png',
  '/favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll([SHELL_URL]).catch(() => undefined))
      .then(() => caches.open(STATIC_CACHE))
      .then((c) => c.addAll(STATIC_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(SW_VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/** URLs that must NEVER be served from a cache: every API call and every
 *  byte of streaming media (the server already micro-caches DaddyLive
 *  manifests with correct TTLs — the SW must not sit in front of that). */
function isNetworkOnly(url) {
  return (
    url.pathname.startsWith('/api/') ||
    /\.(m3u8|ts|m4s|mp4|key|cmf|aac)$/i.test(url.pathname) ||
    url.searchParams.has('XTransformPort')
  );
}

function isStaticBuildAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    STATIC_ASSETS.includes(url.pathname) ||
    /\.(?:png|svg|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isNetworkOnly(url)) return; // streams & APIs: straight to the network

  // navigations → network-first, cached shell offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.open(SHELL_CACHE).then((c) => c.match('/') || Response.error())
        )
    );
    return;
  }

  // static assets → cache-first (immutable/hashed or brand art)
  if (isStaticBuildAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          return hit || Response.error();
        }
      })
    );
  }
});
