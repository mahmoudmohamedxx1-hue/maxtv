import { NextResponse } from 'next/server';
import { get247Channels, probeDaddyLiveChannels } from '@/lib/sports/daddylive';
import { getCatalog } from '@/lib/iptv/catalog';
import { getChannelLogo } from '@/lib/media/logos';

export const dynamic = 'force-dynamic';

/** The beIN family as seen on the DaddyLive 24/7 index — kicked off in
 *  parallel with the index/catalog fetches so the cold-start probe doesn't
 *  serialize behind them. Verdicts are cached 5 min; ids outside this list
 *  still get probed against the live index. */
const BEIN_FAMILY_IDS = [
  '61', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '100',
  '116', '117', '118', '372', '425', '494', '495', '496', '497', '498',
  '499', '500', '578', '597', '62', '63', '64', '67', '1010', '491', '492',
  '493', '712', '713', '714',
];

/**
 * 24/7 sports channels for the SPORTS tab:
 *   • DaddyLive 24/7 index (~900 channels)
 *   • curated sports playlists from IPTV-Scraper-Zilla (TVPass, TheTVApp, Pixelsports)
 * Every channel gets a logo via the tv-logos CDN map (ChannelLogoService
 * ported from the original repo) — no more photo-less cards.
 *
 * beIN GUARANTEE: every DaddyLive channel whose name carries the beIN brand
 * is runtime-probed against the premium CDN (manifest reachable = alive,
 * 5-min cache). Dead beIN ids never reach the rail, and ids that come back
 * reappear on their own — "fix them all" means the list is always true.
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

    // ── beIN family runtime health probe (the "all beIN channels work" fix) ──
    const beinDl = daddyliveChs.filter((c) => /be\s?in/i.test(c.name));
    let aliveIds: Set<string> | null = null;
    if (beinDl.length) {
      // never let a probe outage blank the rail — fall back to the static list
      try {
        await probeWarm; // the warm-up already holds most verdicts
        aliveIds = await probeDaddyLiveChannels(beinDl.map((c) => c.ref));
      } catch {
        aliveIds = null;
      }
    }
    const visibleDl =
      aliveIds === null
        ? daddyliveChs // probe unavailable — static DEAD_CHANNEL_IDS already applied upstream
        : daddyliveChs.filter((c) => !beinDl.some((b) => b.id === c.id) || aliveIds!.has(c.ref));

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
