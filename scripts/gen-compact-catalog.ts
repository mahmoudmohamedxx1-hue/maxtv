// ─────────────────────────────────────────────────────────────────────────────
// Build-time IPTV catalog snapshot generator (part of the Workers deploy).
//
// Runs on the BUILD machine (node, real fs) — NOT in the worker. It performs
// the exact same channel-building loop as src/lib/iptv/catalog.ts build()
// (same m3u parser, same obfuscated-name repair, same category normalize,
// same logo enrichment, same dedupe) and emits a compact JSON snapshot to
// public/__snapshots/iptv-compact.json. The Worker's catalog fast-path then
// serves from this snapshot with a single JSON.parse (~7ms CPU) instead of
// parsing 4.7MB of m3u at runtime (~50ms+ CPU — over the free-plan budget).
//
// Run via scripts/build-worker.mjs (esbuild-bundled for node, then executed).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


import { PLAYLIST_SOURCES, readPlaylistFile } from '../src/lib/iptv/sources';
import { parseM3U, entryToChannel } from '../src/lib/iptv/m3u';
import { normalizeCategory } from '../src/lib/iptv/categories';
import { isObfuscatedName, repairChannelName } from '../src/lib/iptv/repair';
import { getChannelLogo } from '../src/lib/media/logos';
import { getLadderPool } from '../src/lib/iptv/ladderpool';
import type { IPTVChannel, CatalogCategory, ChannelSourceInfo } from '../src/lib/types';

// NOTE: this file is esbuild-bundled to /tmp and executed from the repo
// root (cwd) — import.meta.url would point at the temp bundle, so resolve
// the repo root from process.cwd() (same base sources.ts dataDir() uses).
const ROOT = process.cwd();

function prettify(id: string): string {
  const map: Record<string, string> = {
    movies: 'Movies',
    series: 'Series & Shows',
    entertainment: 'Entertainment',
    news: 'News',
    kids: 'Kids',
    documentary: 'Documentary',
    music: 'Music',
    comedy: 'Comedy',
    anime: 'Anime & Gaming',
    lifestyle: 'Lifestyle',
    world: 'World',
    sports: 'Sports',
  };
  return map[id] ?? id;
}

// mirrors catalog.ts sourcesFor() with all-unknown health (no probing at
// build time) — keeps the Worker's shape identical to a cold Vercel build
function sourcesFor(channels: IPTVChannel[]): ChannelSourceInfo[] {
  const srcCount = new Map<string, number>();
  for (const c of channels) srcCount.set(c.source, (srcCount.get(c.source) || 0) + 1);
  return PLAYLIST_SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    count: srcCount.get(s.id) || 0,
    health: 'unknown' as const,
  }))
    .filter((s) => s.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const channels: IPTVChannel[] = [];
const sportsChannels: IPTVChannel[] = [];
const seen = new Set<string>();
const seenIds = new Set<string>();

for (const src of PLAYLIST_SOURCES) {
  if (src.disabled) continue;
  const content = readPlaylistFile(src);
  if (!content) continue;
  const entries = parseM3U(content);
  for (const e of entries) {
    const ch = entryToChannel(src.id, e);
    if (!ch.url || !/^https?:\/\//i.test(ch.url)) continue;

    if (isObfuscatedName(ch.name)) {
      const repaired = repairChannelName(ch.name, ch.url, ch.logo);
      if (!repaired) continue;
      ch.name = repaired;
    }

    const key = `${ch.name.toLowerCase()}|${ch.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (seenIds.has(ch.id)) {
      let n = 2;
      while (seenIds.has(`${ch.id}-${n}`)) n++;
      ch.id = `${ch.id}-${n}`;
    }
    seenIds.add(ch.id);

    ch.category = normalizeCategory(
      { group: ch.group, name: ch.name, source: src.id, url: ch.url },
      src.forceCategory
    );

    if (!ch.logo) {
      const mapped = getChannelLogo(ch.name);
      if (mapped) ch.logo = mapped;
    }

    channels.push(ch);
    if (src.sports) sportsChannels.push(ch);
  }
}

const sportsIds = new Set(sportsChannels.map((c) => c.id));
const otherChannels = channels.filter((c) => !sportsIds.has(c.id));

const catCount = new Map<string, number>();
for (const c of otherChannels) catCount.set(c.category, (catCount.get(c.category) || 0) + 1);
const CATEGORY_ORDER = [
  'movies', 'series', 'entertainment', 'news', 'kids', 'documentary',
  'music', 'comedy', 'anime', 'lifestyle', 'world', 'sports',
];
const categories: CatalogCategory[] = [{ id: 'all', name: 'All', count: otherChannels.length }];
for (const id of CATEGORY_ORDER) {
  const n = catCount.get(id) || 0;
  if (n > 0) categories.push({ id, name: prettify(id), count: n });
}

const snapshot = {
  version: 2,
  builtAt: Date.now(),
  channels,
  sportsIds: [...sportsIds],
  categories,
  sources: sourcesFor(channels),
  // v2: the ladder-alternates pool rides the snapshot so the Workers data
  // plane can serve it (workerd has no disk — catalog.buildFromSnapshot
  // seeds ladderpool via seedLadderPool). Vercel keeps reading the m3u off
  // disk; both parse with the SAME parseLadderPoolText, so they never drift.
  ladderPool: getLadderPool(),
};

const outDir = join(ROOT, 'public', '__snapshots');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'iptv-compact.json');
writeFileSync(outPath, JSON.stringify(snapshot));
console.log(
  `[gen-compact-catalog] ${channels.length} channels (${sportsChannels.length} sports) → ${outPath}`
);
