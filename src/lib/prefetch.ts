// ─── Stream prefetch (hover → warm the resolve cache) ────────────────────────
// Hovering/focusing a channel card fires the resolve endpoint once per id.
// The server caches the resolved manifest for 5 minutes, so by the time the
// user actually clicks, /api/*/stream answers from cache and the player goes
// straight to Buffering — this is the single biggest perceived-speed win.

import type { Playable } from '@/lib/store';

const warmed = new Set<string>();

export function prefetchStream(ch: Pick<Playable, 'id' | 'kind' | 'ref' | 'name'>): void {
  if (typeof window === 'undefined' || warmed.has(ch.id)) return;
  warmed.add(ch.id);
  const url =
    ch.kind === 'daddylive'
      ? `/api/sports/stream?channel=${encodeURIComponent(ch.ref)}`
      : `/api/iptv/stream?url=${encodeURIComponent(ch.ref)}${ch.name ? `&name=${encodeURIComponent(ch.name)}` : ''}`;
  // fire-and-forget, lowest priority — never compete with real playback
  void fetch(url, { cache: 'no-store', priority: 'low' as RequestPriority }).catch(() => {
    warmed.delete(ch.id); // allow a retry later
  });
}
