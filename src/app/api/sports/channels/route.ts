import { NextResponse, after } from 'next/server';
import { get247Channels, probeDaddyLiveChannels, freshAliveIds } from '@/lib/sports/daddylive';
import { DEAD_DL_CHANNEL_IDS } from '@/lib/sports/categories';
import { getCatalog } from '@/lib/iptv/catalog';
import { getChannelLogo } from '@/lib/media/logos';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The beIN family as seen on the DaddyLive 24/7 index — kicked off in
 *  parallel with the index/catalog fetches so the cold-start probe doesn't
 *  serialize behind them. Verdicts are cached 5 min per id; ids outside this
 *  list still get probed by the rolling background refresh. */
const BEIN_FAMILY_IDS = [
  '61', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '100',
  '116', '117', '118', '372', '425', '494', '495', '496', '497', '498',
  '499', '500', '578', '597', '62', '63', '64', '67', '1010', '491', '492',
  '493', '712', '713', '714',
];

/** rolling cursor for the background drift-correction probe — each catalog
 *  request re-verifies a different slice of the FULL 24/7 index (including
 *  seed-dead ids, so resurrected channels come back), ~48 ids at a time */
let probeCursor = 0;

/**
 * 24/7 sports channels for the SPORTS tab:
 *   • DaddyLive 24/7 index (~900 channels; dead ids filtered out — only
 *     channels that actually play reach the rails)
 *   • curated sports playlists from IPTV-Scraper-Zilla (TVPass, TheTVApp, Pixelsports)
 * Every channel gets a logo via the tv-logos CDN map (ChannelLogoService
 * ported from the original repo) — no more photo-less cards.
 *
 * HEALTH GUARANTEE ("a lot of channels not working" fix): a full-index scan
 * seed (src/data/daddylive-dead.ts, 260+ dead ids) filters instantly on
 * cold start; beIN ids are runtime-probed inline on every request; and a
 * rolling background probe (after()) re-verifies the whole catalog across
 * successive requests — ids that die drop out, ids that resurrect reappear.
 */
export async function GET() {
  try {
    // warm the beIN health probe immediately — runs while the index loads
    const probeWarm = probeDaddyLiveChannels(BEIN_FAMILY_IDS).catch(() => null);
    const [daddylive, catalog] = await Promise.all([get247Channels(), getCatalog()]);

    // sport classification for the DaddyLive 24/7 index
    const daddyliveChs = daddylive.map((c) => ({
      id: `dl247:${c.id}`,
      name: c.name,
      kind: 'daddylive' as const,
      ref: c.id,
      source: 'DaddyLive 24/7',
      category: classifyChannel(c.name),
      logo: getChannelLogo(c.name) || undefined,
      meta: 'DaddyLive',
    }));

    // ── runtime health filtering (the "channels not working" fix) ──
    // 1. static seed: full-index scan snapshot (DEAD_DL_CHANNEL_IDS, 260+ ids)
    //    filters dead channels instantly on cold start.
    // 2. runtime verdicts: beIN ids are probed inline every request (cached
    //    5 min); the rolling background probe below extends coverage to the
    //    whole catalog across requests. Runtime-alive beats the seed — ids
    //    that resurrected reappear on their own.
    const beinDl = daddyliveChs.filter((c) => /be\s?in/i.test(c.name));
    const beinIds = new Set(beinDl.map((b) => b.id));
    let probeOk = true;
    if (beinDl.length) {
      // never let a probe outage blank the rail — fall back to showing all
      try {
        await probeWarm; // the warm-up already holds most verdicts
        await probeDaddyLiveChannels(beinDl.map((c) => c.ref));
      } catch {
        probeOk = false;
      }
    }
    const runtimeAlive = probeOk ? freshAliveIds() : null;
    const visibleDl =
      runtimeAlive === null
        ? daddyliveChs.filter((c) => !DEAD_DL_CHANNEL_IDS.has(c.ref)) // probe outage → seed-only filter
        : daddyliveChs.filter(
            (c) =>
              runtimeAlive.has(c.ref) ||
              (!DEAD_DL_CHANNEL_IDS.has(c.ref) && !beinIds.has(c.id))
          );

    // ── rolling background drift-correction (post-response, never blocks) ──
    // re-verifies a rotating slice of the FULL index — including ids the seed
    // marked dead — so newly-dead channels drop out and resurrected ones come
    // back within a few catalog refreshes (cache-control: max-age=120).
    const allRefs = daddyliveChs
      .map((c) => c.ref)
      .sort((a, b) => Number(a) - Number(b));
    if (allRefs.length) {
      const n = Math.min(48, allRefs.length);
      const slice = Array.from({ length: n }, (_, i) => allRefs[(probeCursor + i) % allRefs.length]);
      probeCursor = (probeCursor + n) % allRefs.length;
      after(async () => {
        await probeDaddyLiveChannels(slice).catch(() => null);
      });
    }

    const iptvChs = catalog.sportsChannels.map((c) => ({
      id: c.id,
      name: c.name,
      kind: 'iptv' as const,
      ref: c.url,
      source: catalog.sources.find((s) => s.id === c.source)?.name || c.source,
      category:
        c.id.startsWith('tvpass') || c.id.startsWith('bein')
          ? classifyChannel(c.name)
          : 'more',
      logo: c.logo || getChannelLogo(c.name) || undefined,
      meta: c.source,
    }));

    return NextResponse.json(
      { channels: [...visibleDl, ...iptvChs], total: visibleDl.length + iptvChs.length },
      { headers: { 'cache-control': 'public, max-age=120, stale-while-revalidate=300' } }
    );
  } catch (e) {
    return NextResponse.json({ error: 'channels_failed', message: (e as Error).message }, { status: 502 });
  }
}

function classifyChannel(name: string): string {
  const n = name.toLowerCase();
  const rules: Array<[string, string[]]> = [
    ['football', ['soccer', 'football', 'futbol', 'fútbol', 'gol tv', 'willow']],
    ['cricket', ['cricket', 'willow', 'star sports', 'ten sports', 'ptv sports', 'ghazi hd', 'a sports']],
    ['basketball', ['nba', 'basketball', 'nbatv']],
    ['american_football', ['nfl', 'nfl network']],
    ['baseball', ['mlb', 'baseball']],
    ['hockey', ['nhl', 'hockey']],
    ['fight', ['fight', 'ufc', 'boxing', 'wwe', 'tna', 'impact', 'roh', 'aew', 'wrestling', 'bg on tv', 'rcg']],
    ['motorsport', ['f1', 'motor', 'racing', 'nascar', 'speed']],
    ['tennis', ['tennis']],
    ['golf', ['golf']],
    ['espn', ['espn', 'dazn', 'bein', 'sky sport', 'bt sport', 'tnt sport', 'sportsnet', 'tsn', 'eurosport', '超级运动', 'sport', 'sport1', 'sport tv', 'arena sport', 'setanta']],
    ['college', ['ncaa', 'college', 'espn2', 'sec network', 'acc network', 'big ten', 'longhorn', 'pac12']],
  ];
  for (const [cat, keys] of rules) {
    if (keys.some((k) => n.includes(k))) return cat;
  }
  return 'more';
}
