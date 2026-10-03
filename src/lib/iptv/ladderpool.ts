// ─── Curated ladder-alternates pool ───────────────────────────────────────────
// data/iptv/LadderAlts.m3u — same-channel sources VERIFIED (at build time, by
// scripts/build-ladder-alts.py) to ship real multi-variant master playlists.
// The pool is an invisible extension of findAlternates(): its entries arrive
// with their quality rungs pre-attached (x-ladder), so the player's quality
// menu can render "More qualities" rungs WITHOUT a runtime manifest probe —
// the probe path stays for catalog-discovered alternates only.
//
// Why a static pool: DaddyLive CDNs are single-rendition and ffmpeg is dead
// on serverless, so multi-quality only exists where ANOTHER source carries
// the SAME channel with an ABR ladder. Those sources are rare and flaky at
// probe time — pre-verifying them once and shipping the snapshot makes the
// rungs appear instantly and reliably, on every deployment.

import fs from 'fs';
import path from 'path';

export interface LadderPoolEntry {
  name: string;
  url: string;
  logo?: string;
  /** verified variant heights, ascending (240/360/480/…) */
  ladder: number[];
}

let cached: LadderPoolEntry[] | null = null;

/** friendly provider label from the stream host (shown as "via <label>") */
export function providerLabelFromUrl(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'HD source';
  }
  if (host.includes('amagi')) return 'Amagi CDN';
  if (host.includes('akamaized')) return 'Akamai CDN';
  if (host.includes('cloudfront')) return 'CloudFront';
  if (host.includes('pluto')) return 'Pluto TV';
  if (host.includes('samsungcloud') || host.includes('samsung')) return 'Samsung TV+';
  if (host.includes('wurl')) return 'Wurl';
  if (host.includes('jmp2.uk')) return 'Plex';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'IPTV relay';
  const label = host.split('.')[0].replace(/[-_]/g, ' ');
  return label ? label[0].toUpperCase() + label.slice(1) : 'HD source';
}

/** parse the pool playlist once per process (static data — no TTL) */
export function getLadderPool(): LadderPoolEntry[] {
  if (cached) return cached;
  cached = [];
  try {
    const file = path.join(process.cwd(), 'data', 'iptv', 'LadderAlts.m3u');
    const text = fs.readFileSync(file, 'utf-8');
    let pending: { name: string; logo?: string; ladder: number[] } | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF')) {
        const name = line.split(',', 1)[0] && line.includes(',') ? line.slice(line.indexOf(',') + 1).trim() : '';
        const ladder = /x-ladder="([\d/]+)"/.exec(line)?.[1];
        const logo = /tvg-logo="([^"]*)"/.exec(line)?.[1];
        pending = {
          name,
          logo: logo || undefined,
          ladder: ladder ? ladder.split('/').map(Number).filter((n) => n > 0) : [],
        };
      } else if (/^https?:\/\//i.test(line) && pending) {
        if (pending.name && pending.ladder.length >= 2) {
          cached.push({ name: pending.name, url: line, logo: pending.logo, ladder: pending.ladder });
        }
        pending = null;
      }
    }
  } catch {
    /* no pool file → empty pool, catalog alternates still work */
  }
  return cached;
}
