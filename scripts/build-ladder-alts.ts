// ─────────────────────────────────────────────────────────────────────────────
// Build the curated ladder-alternates pool (data/iptv/LadderAlts.m3u).
//
// WHAT THIS DOES
//   DaddyLive 24/7 channels are single-rendition (no quality menu). Some other
//   provider carries the SAME channel with a real ABR ladder — those pairs are
//   the only source of true multi-quality rungs for DL channels. This script
//   finds and verifies them once at build time:
//
//     1. DL 24/7 channel names — live from the DaddyLive mirrors (the exact
//        list the app serves), with a --dl-json fallback for offline runs.
//     2. Candidates — TWO indexes, both matched with the REAL runtime match
//        core exported from src/lib/iptv/catalog.ts (prepareChannelMatch +
//        matchChannelProfiles — zero drift from production findAlternates):
//          a. the app catalog (FAST playlists + WorldSports + …)
//          b. the iptv-org public index (channels.json + streams.json) —
//             the only broad source of LINEAR channels (AMC, Discovery, Nat
//             Geo, national feeds) that FAST catalogs don't carry
//     3. US-strip pass — DL names carry USA suffixes ("AMC USA") that FAST
//        providers and iptv-org don't ("AMC"). The runtime region guard must
//        stay strict (beIN language swaps), so the BUILDER makes this hop
//        once, gated on market evidence (US-market sources / country=US),
//        and emits the entry under the FULL DL name → runtime match is tier-1.
//     4. Probe — every candidate URL fetched (8s + one retry, browser UA,
//        per-stream UA/Referer honored), parsed with the REAL parseLadder().
//        Masters with >= --min-rungs RESOLUTION-bearing variants qualify.
//        Two waves: primaries first, backups only for channels still rungless.
//     5. Select — best verified candidate per DL channel (score: rung count,
//        720/1080 top, tier-1 identity, source health, stable-CDN bonus,
//        country evidence, flaky-provider penalty).
//     6. Emit — entry named EXACTLY like the DL channel (tier-1 + region +
//        number guards all pass at runtime), rungs pre-attached via
//        x-ladder, logo from the winning provider. Verified legacy entries
//        that no DL channel claims are kept.
//
// RUN (from repo root, via the esbuild wrapper):
//   node scripts/run-ladder-alts.mjs [--dl-json <file>] [--out <file>]
//        [--concurrency 12] [--min-rungs 2] [--no-iptvorg] [--dry-run]
//        [--verbose] [--dump-cands=<file>]
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit, cwd } from 'node:process';

import { get247Channels } from '../src/lib/sports/daddylive';
import {
  getCatalog,
  findAlternates,
  prepareChannelMatch,
  matchChannelProfiles,
  type AlternateChannel,
  type ChannelMatchProfile,
} from '../src/lib/iptv/catalog';
import { getLadderPool, parseLadderPoolText } from '../src/lib/iptv/ladderpool';
import { parseLadder } from '../src/lib/streaming/ladder';
import { fetchTolerant } from '../src/lib/streaming/tls-fetch';
import { UA } from '../src/lib/streaming/resolve';

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const ROOT = cwd();
const OUT = arg('out', join(ROOT, 'data', 'iptv', 'LadderAlts.m3u'));
const DL_JSON = argv.includes('--dl-json') ? arg('dl-json', '') : '';
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '12')) || 12);
const MIN_RUNGS = Math.max(2, Number(arg('min-rungs', '2')) || 2);
const EXT_MAX_URLS = Math.max(1, Number(arg('ext-max-urls', '4')) || 4);
const NO_IPTVORG = argv.includes('--no-iptvorg');
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
/** parity harness: dump the (dlName, source, url) candidate triples so the
 *  match-core refactor can be verified byte-identical against the old code */
const DUMP_CANDS = (argv.find((a) => a.startsWith('--dump-cands=')) || '').slice('--dump-cands='.length) || '';

const log = (...a: unknown[]) => console.log('[ladder-alts]', ...a);
const die = (msg: string): never => {
  throw new Error(`FATAL: ${msg}`);
};

// ── 1. DL 24/7 channel names ─────────────────────────────────────────────────
interface Named {
  name: string;
}
async function loadDlNames(): Promise<string[]> {
  if (DL_JSON && existsSync(DL_JSON)) {
    const raw = JSON.parse(readFileSync(DL_JSON, 'utf-8')) as unknown;
    const list = Array.isArray(raw)
      ? (raw as Named[])
      : ((raw as { channels?: Named[] }).channels ?? []);
    const names = list.map((c) => c?.name).filter((n): n is string => !!n);
    log(`DL names from --dl-json: ${names.length}`);
    return names;
  }
  try {
    const chs = await get247Channels();
    const names = chs.map((c) => c.name).filter(Boolean);
    log(`DL names live from mirrors: ${names.length}`);
    if (names.length < 50) throw new Error(`suspiciously small list (${names.length})`);
    return names;
  } catch (e) {
    throw new Error(
      `live 24/7 fetch failed (${(e as Error).message}) — re-run with --dl-json <file> ` +
        `(saved snapshot: scripts/bein-research/dl247.json shape {channels:[{name}]})`
    );
  }
}

// ── candidates ───────────────────────────────────────────────────────────────
const norm = (n: string): string =>
  n.toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(hd|fhd|uhd|4k|sd|hq)\b/g, '').replace(/[^a-z0-9]/g, '');

interface Cand {
  dlName: string;
  /** 0 = primary (internal match or first external stream), 1 = backup wave */
  prio: 0 | 1;
  /** US-strip candidates carry market evidence the runtime never sees */
  viaUsStrip?: boolean;
  /** iptv-org country code (external candidates) — scoring evidence */
  country?: string;
  /** per-stream fetch hints (external candidates) */
  headers?: Record<string, string>;
  alt: AlternateChannel;
}

/** US-market FAST sources — their unqualified “AMC” is DL's “AMC USA”.
 *  (Plex/Samsung ship multi-country catalogs but are US-dominant; their
 *  regional twins of US FAST channels carry identical network content.) */
const US_SOURCES = new Set([
  'pluto', 'samsung', 'plex', 'roku', 'stirr', 'tubi', 'xumo', 'lgtv',
  'uslocal', 'klowd', 'distro', 'fstv',
]);

/** trailing US qualifier on a DL name — “AMC USA” / “A&E US” / “Newsmax (USA)”. */
const TRAILING_US = /\s*\(?\b(usa|us)\b\)?\s*$/i;

// ── 2a. internal candidates via the REAL runtime matcher ────────────────────
async function collectInternal(dlNames: string[], dlProfiles: Map<string, ChannelMatchProfile>): Promise<Cand[]> {
  const seenDl = new Set<string>();
  const cands: Cand[] = [];
  let stripped = 0;
  let n = 0;
  for (const dlName of dlNames) {
    const key = norm(dlName);
    if (!key || key.length < 3 || seenDl.has(key)) continue;
    seenDl.add(key);
    n++;
    let alts: AlternateChannel[] = [];
    try {
      alts = await findAlternates(dlName, '', 12);
    } catch {
      alts = [];
    }
    for (const a of alts) {
      if (a.sameChannel !== true) continue; // family tiers never become rungs
      if (!/^https?:\/\//i.test(a.url || '')) continue;
      cands.push({ dlName, prio: 0, alt: a });
    }
    // US-strip pass: DL name ends in a US qualifier, provider is US-market.
    const m = TRAILING_US.exec(dlName);
    if (m) {
      const core = dlName.slice(0, dlName.length - m[0].length).trim();
      if (core && norm(core).length >= 3 && norm(core) !== key) {
        let alts2: AlternateChannel[] = [];
        try {
          alts2 = await findAlternates(core, '', 12);
        } catch {
          alts2 = [];
        }
        let added = 0;
        for (const a of alts2) {
          if (a.sameChannel !== true) continue;
          if (!/^https?:\/\//i.test(a.url || '')) continue;
          if (!US_SOURCES.has(a.source)) continue; // market evidence
          cands.push({ dlName, prio: 0, viaUsStrip: true, alt: a });
          added++;
        }
        if (added) stripped++;
      }
    }
    if (VERBOSE && n % 200 === 0) log(`internal scan ${n}/${dlNames.length} names, ${cands.length} candidates`);
  }
  log(`internal: ${n} unique DL names → ${cands.length} candidates (${stripped} names gained US-stripped candidates)`);
  return cands;
}

// ── 2b. external candidates: the iptv-org index ─────────────────────────────
interface ExtStream {
  url: string;
  ua?: string;
  ref?: string;
}
interface ExtChannel {
  id: string;
  names: string[]; // display name + alt_names
  country: string;
  logo?: string;
  streams: ExtStream[];
  isNsfw: boolean;
}
interface IptvOrgIndex {
  fetchedAt: number;
  channels: ExtChannel[];
}

const IPTVORG_CACHE = '/tmp/maxtv-iptvorg-index.json';
const IPTVORG_TTL_MS = 12 * 60 * 60 * 1000;

async function loadIptvOrg(): Promise<IptvOrgIndex | null> {
  if (NO_IPTVORG) return null;
  if (existsSync(IPTVORG_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(IPTVORG_CACHE, 'utf-8')) as IptvOrgIndex;
      if (Date.now() - cached.fetchedAt < IPTVORG_TTL_MS && cached.channels?.length) {
        log(`iptv-org index from cache: ${cached.channels.length} channels`);
        return cached;
      }
    } catch {
      /* refetch */
    }
  }
  try {
    const [chRes, stRes] = await Promise.all([
      fetchTolerant('https://iptv-org.github.io/api/channels.json', { headers: { 'User-Agent': UA }, timeoutMs: 30000 }),
      fetchTolerant('https://iptv-org.github.io/api/streams.json', { headers: { 'User-Agent': UA }, timeoutMs: 60000 }),
    ]);
    if (!chRes.ok || !stRes.ok) throw new Error(`channels.json ${chRes.status}, streams.json ${stRes.status}`);
    type RawCh = { id: string; name: string; alt_names?: string[]; country?: string; logo?: string; is_nsfw?: boolean };
    type RawSt = { channel?: string; url?: string; user_agent?: string; referrer?: string };
    const rawCh = JSON.parse(await chRes.text()) as RawCh[];
    const rawSt = JSON.parse(await stRes.text()) as RawSt[];
    const byId = new Map<string, ExtChannel>();
    for (const c of rawCh) {
      if (!c?.id || !c?.name || c.is_nsfw) continue;
      byId.set(c.id, {
        id: c.id,
        names: [c.name, ...(c.alt_names || [])],
        country: (c.country || '').toUpperCase(),
        logo: c.logo,
        streams: [],
        isNsfw: false,
      });
    }
    let orphan = 0;
    for (const s of rawSt) {
      if (!s?.url || !/^https?:\/\//i.test(s.url)) continue;
      const ch = s.channel ? byId.get(s.channel) : undefined;
      if (!ch) {
        orphan++;
        continue;
      }
      ch.streams.push({ url: s.url, ua: s.user_agent || undefined, ref: s.referrer || undefined });
    }
    const channels = [...byId.values()].filter((c) => c.streams.length > 0);
    log(`iptv-org index: ${channels.length} channels with streams (${rawSt.length} streams, ${orphan} orphaned)`);
    const idx: IptvOrgIndex = { fetchedAt: Date.now(), channels };
    try {
      writeFileSync(IPTVORG_CACHE, JSON.stringify(idx));
    } catch {
      /* cache is best-effort */
    }
    return idx;
  } catch (e) {
    log(`iptv-org index unavailable (${(e as Error).message}) — continuing without it`);
    return null;
  }
}

/** rough region-class → country evidence map (scoring only, never a gate) */
const REGION_COUNTRY: Record<string, string[]> = {
  us: ['US'],
  uk: ['GB', 'UK'],
  'mena-ar': ['QA', 'SA', 'AE', 'EG', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'MA', 'DZ', 'TN', 'LY', 'SD', 'YE', 'PS', 'MR', 'SO', 'DJ', 'KM'],
  fr: ['FR', 'BE', 'LU', 'MC', 'CA'],
  de: ['DE', 'AT', 'CH', 'LI'],
  es: ['ES', 'PT', 'MX', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'BO', 'PY', 'UY', 'CR', 'GT', 'HN', 'NI', 'PA', 'DO', 'CU', 'SV'],
  tr: ['TR', 'CY'],
  my: ['MY', 'BN'],
  au: ['AU', 'NZ'],
  apac: ['SG', 'HK', 'TW', 'JP', 'KR', 'IN', 'ID', 'TH', 'PH', 'VN', 'CN', 'MY', 'AU', 'NZ'],
  en: ['US', 'GB', 'UK', 'CA', 'AU', 'IE', 'NZ', 'ZA'],
};

function collectExternal(
  dlNames: string[],
  dlProfiles: Map<string, ChannelMatchProfile>,
  idx: IptvOrgIndex | null
): Cand[] {
  if (!idx) return [];
  // precompute one profile per (channel, name-variant)
  interface ExtProfile {
    profile: ChannelMatchProfile;
    channel: ExtChannel;
  }
  const extProfiles: ExtProfile[] = [];
  for (const ch of idx.channels) {
    for (const nm of ch.names) {
      if (!nm) continue;
      extProfiles.push({ profile: prepareChannelMatch(nm), channel: ch });
    }
  }
  log(`iptv-org match surface: ${extProfiles.length} name profiles`);

  const cands: Cand[] = [];
  const seenDl = new Set<string>();
  let matched = 0;
  let stripped = 0;
  let ambiguous = 0;
  for (const dlName of dlNames) {
    const key = norm(dlName);
    if (!key || key.length < 3 || seenDl.has(key)) continue;
    seenDl.add(key);
    const want = dlProfiles.get(dlName)!;
    const take = (ch: ExtChannel, viaUsStrip: boolean): number => {
      let added = 0;
      for (const s of ch.streams.slice(0, EXT_MAX_URLS)) {
        if (!/^https?:\/\//i.test(s.url)) continue;
        cands.push({
          dlName,
          prio: added === 0 ? 0 : 1, // first stream is primary, rest are backups
          viaUsStrip: viaUsStrip || undefined,
          country: ch.country || undefined,
          headers: {
            'User-Agent': s.ua || UA,
            Accept: '*/*',
            ...(s.ref ? { Referer: s.ref } : {}),
          },
          alt: {
            id: `iptvorg:${ch.id}`,
            name: ch.names[0],
            source: 'iptvorg',
            sourceName: 'IPTV-ORG',
            url: s.url,
            logo: ch.logo,
          },
        });
        added++;
      }
      return added;
    };
    // pass 1 — full-name match. Ambiguity guard: when the SAME name is a
    // different network in >= 2 countries (Citytv CA/BG/CO, Discovery
    // regional feeds …) an unqualified DL name cannot be resolved to the
    // right one — freeze nothing rather than the wrong feed. US-strip pass
    // is exempt (country evidence) and internal candidates are unaffected.
    const tier1 = new Map<string, ExtChannel[]>(); // country → channels
    for (const ep of extProfiles) {
      if (ep.profile.norm !== want.norm) continue; // tier-1 only
      const list = tier1.get(ep.channel.country) || [];
      list.push(ep.channel);
      tier1.set(ep.channel.country, list);
    }
    let hit = false;
    if (tier1.size <= 1) {
      for (const [, chs] of tier1) for (const ch of chs) if (take(ch, false)) hit = true;
    } else {
      ambiguous++;
      if (VERBOSE) log(`  ambiguous name skipped (external): ${dlName} → ${[...tier1.keys()].join('/')}`);
    }
    if (hit) matched++;
    // US-strip pass with country evidence
    const m = TRAILING_US.exec(dlName);
    if (m) {
      const core = dlName.slice(0, dlName.length - m[0].length).trim();
      if (core && norm(core).length >= 3 && norm(core) !== key) {
        const strippedWant = prepareChannelMatch(core);
        let hit2 = false;
        for (const ep of extProfiles) {
          if (ep.channel.country !== 'US') continue; // market evidence
          const verdict = matchChannelProfiles(strippedWant, ep.profile, 'iptvorg');
          if (!verdict || verdict.sameChannel !== true) continue;
          if (take(ep.channel, true)) hit2 = true;
        }
        if (hit2) stripped++;
      }
    }
  }
  log(
    `external: ${matched} DL names matched iptv-org channels (${stripped} via US-strip, ${ambiguous} ambiguous names skipped) → ${cands.length} stream candidates`
  );
  return cands;
}

// ── 3. probe candidate masters ───────────────────────────────────────────────
interface ProbeOk {
  heights: number[];
  ms: number;
}

const failReasons = new Map<string, number>();
const fail = (why: string): void => {
  failReasons.set(why, (failReasons.get(why) || 0) + 1);
};

async function probeMaster(url: string, headers?: Record<string, string>): Promise<ProbeOk | null> {
  const hdr = { 'User-Agent': UA, Accept: '*/*', ...(headers || {}) };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetchTolerant(url, { headers: hdr, timeoutMs: 8000 });
      if (res.ok) {
        const body = await res.text();
        if (body.includes('#EXTM3U')) {
          const parsed = parseLadder(body);
          if (parsed.heights.length >= MIN_RUNGS) {
            return { heights: parsed.heights, ms: Date.now() - t0 };
          }
          fail(parsed.heights.length === 1 ? 'single-variant master' : 'media playlist (no ladder)');
          return null;
        }
        fail('not a playlist');
        return null; // not a playlist
      }
      if ([403, 404, 410, 451].includes(res.status)) {
        fail(`http ${res.status}`);
        return null; // definitive
      }
      // 429/5xx → retry once
    } catch {
      /* network error → retry once */
    }
  }
  fail('network/timeout');
  return null;
}

async function probeAll(cands: Cand[], urls?: Set<string>): Promise<Map<string, ProbeOk>> {
  const queue = cands.filter((c) => !urls || !urls.has(c.alt.url));
  const results = new Map<string, ProbeOk>();
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const ok = await probeMaster(c.alt.url, c.headers);
      if (ok) {
        results.set(c.alt.url, ok);
        if (VERBOSE) log(`  ✓ ${c.dlName} ← ${c.alt.url.slice(0, 80)} [${ok.heights.join('/')}] ${ok.ms}ms`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 4. score + select the best candidate per DL channel ─────────────────────
const STABLE_HOSTS = /jmp2\.uk|amagi|akamaized|cloudfront|samsungcloud|pluto\.tv|wurl|rtve/i;
const FLAKY_HOSTS = /moveonjoy|tvpass|udptv|sofast|klowdtv|wns\.live|greektoday|utako|mangeinde|aynaott|toffeelive|b-cdn|streann|mediacdn/i;

// ── candidate safety guards (applied BEFORE probing) ────────────────────────
// The pool freezes a name→URL pairing; a WRONG pairing is a content swap the
// runtime can never detect. Two hard guards:
/** dedicated-playout brand tokens — when the HOSTNAME carries one of these
 *  brands but the channel name does not, the URL is almost certainly a
 *  mis-mapped playout (measured: iptv-org "History" US pointing at VICE TV's
 *  dedicated vicetv-vicefast1 playout). Shared CDNs (tsv2.amagi.tv,
 *  cloudfront, jmp2.uk, playouts.now.amagi.tv/amgNNNNN) never trip this:
 *  their hostnames carry no channel brand. Corporate families (NBC hosting
 *  Telemundo) are deliberately NOT listed — nbc/abc/cbs/fox double as both
 *  brand and parent-company tokens and would false-reject. */
const BRAND_TOKENS = [
  'vice', 'espn', 'cnn', 'bloomberg', 'nickelodeon', 'disney', 'cartoon',
  'hgtv', 'tlc', 'discovery', 'history', 'natgeo', 'paramount', 'starz',
  'showtime', 'mgm', 'redbull', 'weather', 'msnbc', 'bbc', 'itv', 'zdf',
  'arte', 'rtl', 'prosieben', 'tf1', 'canal', 'antena', 'movistar', 'bein',
  'dazn', 'eurosport', 'skysport',
];

/** reject a candidate URL for the given channel name (content-swap risk) */
function unsafeUrl(url: string, chName: string): string | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unparseable URL';
  }
  // raw IP relays: unstable, unverifiable, and reassignable — never frozen
  // into a static pool
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'raw IP host';
  const name = chName.toLowerCase();
  for (const b of BRAND_TOKENS) {
    if (host.includes(b) && !name.includes(b)) return `brand conflict (${b})`;
  }
  return null;
}

function score(alt: AlternateChannel, probe: ProbeOk, dlName: string, country?: string): number {
  let s = 0;
  if (norm(alt.name) === norm(dlName)) s += 8; // tier-1 identity
  s += Math.min(50, probe.heights.length * 10); // rung variety
  const top = Math.max(...probe.heights);
  if (top >= 1080) s += 5;
  else if (top >= 720) s += 3;
  if (alt.health === 'ok') s += 3;
  if (alt.source === 'ladderalts') s += 6; // incumbent curated entry
  if (alt.source === 'worldsports') s += 4; // repo-curated verified ladder source
  if (alt.source === 'iptvorg') s -= 2; // public index: less predictable uptime
  let host = '';
  try {
    host = new URL(alt.url).hostname;
  } catch {
    /* scoring only */
  }
  if (STABLE_HOSTS.test(host)) s += 2;
  if (FLAKY_HOSTS.test(host)) s -= 4;
  // country evidence: DL region class ↔ external channel country
  if (country) {
    const dlRegion = dlRegionClass(dlName);
    if (dlRegion && (REGION_COUNTRY[dlRegion] || []).includes(country)) s += 2;
  }
  return s;
}

/** region class of a DL name (mirror of catalog's regionClass — scoring only;
 *  the GATE is always the exported matcher, this is just tie-break evidence) */
function dlRegionClass(n: string): string {
  if (/\benglish\b/i.test(n)) return 'en';
  if (/\barabic\b|\bmena\b|\b(ksa|qatar|egypt)\b/i.test(n)) return 'mena-ar';
  if (/\bturk(ey|ish|ce)\b/i.test(n)) return 'tr';
  if (/\bfrance\b|\bfrench\b/i.test(n)) return 'fr';
  if (/\baustralia\b/i.test(n)) return 'au';
  if (/\bmalaysia\b/i.test(n)) return 'my';
  if (/\busa\b|\bus\b|\bespa[nñ]ol\b|\bhispanic\b|\bamerica(?:n)?\b/i.test(n)) return 'us';
  if (/\buk\b/i.test(n)) return 'uk';
  if (/\bgermany\b|\bgerman\b/i.test(n)) return 'de';
  if (/\bspain\b|\bportugal\b/i.test(n)) return 'es';
  if (/\basia\b|\bpacific\b/i.test(n)) return 'apac';
  if (/\bpremium\b/i.test(n)) return 'premium';
  return '';
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const t0 = Date.now();
  const dlNames = await loadDlNames();
  log('building catalog (on-disk playlists; hourly upstream refresh runs in background)…');
  await getCatalog();

  const dlProfiles = new Map<string, ChannelMatchProfile>();
  for (const n of dlNames) dlProfiles.set(n, prepareChannelMatch(n));

  const internal = await collectInternal(dlNames, dlProfiles);
  const idx = await loadIptvOrg();
  const external = collectExternal(dlNames, dlProfiles, idx);
  let cands = [...internal, ...external];
  // safety guards (content-swap risk) — applied BEFORE any probing
  const rejected = new Map<string, number>();
  cands = cands.filter((c) => {
    const why = unsafeUrl(c.alt.url, c.dlName);
    if (why) {
      rejected.set(why, (rejected.get(why) || 0) + 1);
      return false;
    }
    return true;
  });
  log(
    `safety guards rejected ${rejected.size ? [...rejected.values()].reduce((a, b) => a + b, 0) : 0} candidates: ` +
      `${[...rejected.entries()].map(([w, n]) => `${w}=${n}`).join(' ') || 'none'}`
  );
  if (DUMP_CANDS) {
    writeFileSync(
      DUMP_CANDS,
      cands.map((c) => `${c.dlName}\t${c.alt.source}\t${c.alt.url}`).sort().join('\n') + '\n',
      'utf-8'
    );
    log(`candidate dump → ${DUMP_CANDS}`);
  }
  if (!cands.length) die('no candidates at all — refusing to write an empty pool');

  // ── probe waves ───────────────────────────────────────────────────────────
  const uniqueUrls = new Set(cands.map((c) => c.alt.url));
  log(`probing wave A (primaries): ${cands.filter((c) => c.prio === 0).length} of ${uniqueUrls.size} unique URLs (concurrency ${CONCURRENCY})…`);
  let probed = await probeAll(cands.filter((c) => c.prio === 0));
  log(`wave A verified: ${probed.size}`);

  const hasVerified = (dlName: string): boolean =>
    cands.some((c) => c.dlName === dlName && probed.has(c.alt.url));

  const backupCands = cands.filter((c) => c.prio === 1 && !hasVerified(c.dlName));
  if (backupCands.length) {
    log(`probing wave B (backups for rungless channels): ${backupCands.length}…`);
    const more = await probeAll(backupCands, new Set(probed.keys()));
    for (const [k, v] of more) probed.set(k, v);
    log(`cumulative verified: ${probed.size}`);
  }
  log(
    `probe failures: ${[...failReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([w, n]) => `${w}=${n}`)
      .join(' ') || 'none'}`
  );

  // ALSO re-verify legacy pool entries directly — they may serve channels the
  // DL 24/7 list no longer carries (IPTV-tab channels still match them)
  const legacyPool = getLadderPool().filter((e) => {
    const why = unsafeUrl(e.url, e.name);
    if (why) {
      log(`legacy entry dropped (${why}): ${e.name}`);
      return false;
    }
    return true;
  });
  const legacyCands: Cand[] = legacyPool.map((e) => ({
    dlName: e.name,
    prio: 0 as const,
    alt: {
      id: `legacy:${e.url}`,
      name: e.name,
      source: 'ladderalts',
      sourceName: 'legacy pool',
      url: e.url,
      logo: e.logo,
      ladder: e.ladder,
    },
  }));
  const legacyMore = await probeAll(legacyCands, new Set(probed.keys()));
  for (const [k, v] of legacyMore) probed.set(k, v);
  log(`after legacy re-verify: ${probed.size} verified masters total`);

  // pick best per DL channel
  const best = new Map<string, { alt: AlternateChannel; probe: ProbeOk; score: number }>();
  for (const { dlName, alt, country } of cands) {
    const probe = probed.get(alt.url);
    if (!probe) continue;
    const sc = score(alt, probe, dlName, country);
    const cur = best.get(dlName);
    if (!cur || sc > cur.score) best.set(dlName, { alt, probe, score: sc });
  }

  // emission: DL-name-verbatim entries (tier-1 guaranteed at runtime)
  interface Emit {
    name: string;
    url: string;
    logo?: string;
    ladder: number[];
  }
  const emits: Emit[] = [];
  const emittedNorm = new Set<string>();
  for (const [dlName, { alt, probe }] of [...best.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = dlName.replace(/[,"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) continue;
    const nk = norm(name);
    if (emittedNorm.has(nk)) continue; // two DL twins → one entry
    emittedNorm.add(nk);
    const logo = (alt.logo || '').replace(/"/g, '').trim();
    emits.push({
      name,
      url: alt.url,
      logo: logo || undefined,
      ladder: [...new Set(probe.heights)].sort((a, b) => a - b),
    });
  }

  // legacy keep: verified incumbents no DL emission claimed (IPTV-tab value)
  const legacyKept: Emit[] = [];
  for (const e of legacyPool) {
    if (emittedNorm.has(norm(e.name))) continue;
    const probe = probed.get(e.url);
    if (!probe) continue;
    legacyKept.push({
      name: e.name.replace(/[,"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60),
      url: e.url,
      logo: e.logo,
      ladder: [...new Set(probe.heights)].sort((a, b) => a - b),
    });
    emittedNorm.add(norm(e.name));
  }

  const all = [...emits, ...legacyKept];
  const providerOf = (u: string): string => {
    try {
      return new URL(u).hostname;
    } catch {
      return '?';
    }
  };
  const histogram = new Map<string, number>();
  for (const e of all) {
    const h = providerOf(e.url);
    histogram.set(h, (histogram.get(h) || 0) + 1);
  }

  log(`──────── summary ────────`);
  log(`DL channels with verified rungs: ${emits.length}/${dlNames.length}`);
  log(`legacy entries kept: ${legacyKept.length}/${legacyPool.length}`);
  log(`pool total: ${all.length} entries`);
  log(
    `providers: ${[...histogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => `${h}=${n}`)
      .join(' ')}`
  );
  const sports = emits.filter((e) => /sport|espn|bein|sky|tnt|dazn|star|arena|abu dhabi|astro|nhl|nba|mlb|nfl|tennis|fight|golf|motor|rally|ufc|boxing|tdp|olympic/i.test(e.name));
  log(`sports-flavored entries: ${sports.length} — ${sports.slice(0, 15).map((e) => e.name).join(', ')}`);
  log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (DRY) {
    log('dry-run — not writing');
    for (const e of emits.slice(0, 40)) log(`  ${e.name} [${e.ladder.join('/')}] ← ${providerOf(e.url)}`);
    return;
  }

  // ── emit the m3u ──────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('#EXTM3U');
  lines.push('# Curated same-channel ABR-ladder alternates for DaddyLive 24/7 channels.');
  lines.push('# Every entry VERIFIED at build time to ship a multi-variant master');
  lines.push('# playlist (real quality rungs, heights in x-ladder, ascending).');
  lines.push('# Entry names are the DL 24/7 channel names VERBATIM so the runtime');
  lines.push('# matcher (findAlternates) tier-1-matches them with region + channel-');
  lines.push('# number guards intact. Consumed as an invisible pool — never a UI rail.');
  lines.push('# Regenerate: node scripts/run-ladder-alts.mjs (see build-ladder-alts.ts).');
  lines.push(
    `# Generated ${new Date().toISOString()} — ${emits.length} DL channels + ${legacyKept.length} legacy, ` +
      `${all.length} entries total.`
  );
  for (const e of all) {
    const attrs = [e.logo ? `tvg-logo="${e.logo}"` : '', 'group-title="Ladder Alternates"', `x-ladder="${e.ladder.join('/')}"`]
      .filter(Boolean)
      .join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${e.name}`);
    lines.push(e.url);
  }
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf-8');
  log(`wrote ${OUT} (${all.length} entries)`);

  // ── self-check: the emitted file must parse back through the SAME parser ──
  const reparsed = parseLadderPoolText(readFileSync(OUT, 'utf-8'));
  if (reparsed.length !== all.length) {
    die(`self-check failed: parsed ${reparsed.length} != emitted ${all.length}`);
  }
  log(`self-check ok: ${reparsed.length} entries parse back cleanly`);
}

main()
  .then(() => exit(0))
  .catch((e) => {
    console.error(`[ladder-alts] ${(e instanceof Error ? e.stack : String(e)) || e}`);
    exit(1);
  });
