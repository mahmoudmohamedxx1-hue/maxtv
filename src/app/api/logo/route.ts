import { NextResponse } from 'next/server';
import { getChannelLogo, getLeagueLogo, extractTeamsFromTitle, findTeamLogo } from '@/lib/media/logos';
import { getCatalog } from '@/lib/iptv/catalog';

export const dynamic = 'force-dynamic';

function norm(n: string): string {
  return n
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(hd|fhd|uhd|4k|sd|hq)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** catalog logo for an IPTV channel name (playlist tvg-logo / enriched map) */
async function catalogLogo(name: string): Promise<string | null> {
  try {
    const cat = await getCatalog();
    const want = norm(name);
    const core = want.replace(/^[0-9]+/, '');
    for (const ch of cat.channels) {
      const n = norm(ch.name);
      if ((n === want || (core.length >= 5 && n.replace(/^[0-9]+/, '') === core)) && ch.logo) {
        return ch.logo;
      }
    }
  } catch {
    /* catalog unavailable */
  }
  return null;
}

/**
 * Batch logo lookup for persisted recents/favorites that were saved without a
 * logo (backfill on session start). GET /api/logo?names=A|B|C
 *
 * Resolution order per name (the original repo's ChannelLogoService chain):
 *   1. curated channel logos + tv-logos CDN map (sync)
 *   2. league emblem for competition names (sync)
 *   3. catalog tvg-logo for IPTV channel names
 *   4. team crest for "Team A vs Team B" fixture titles (seed + TheSportsDB)
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('names') || '';
  const names = raw
    .split('|')
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 60);

  const logos: Record<string, string> = {};
  const asyncTeams: string[] = [];
  const asyncCatalog: string[] = [];

  for (const name of names) {
    // fixture titles are stored as "Team A vs Team B — Feed 2" — use the match
    // part for crest lookup, the feed part for channel-logo lookup
    const parts = name.split(/\s+—\s+/);
    const matchPart = parts[0].trim();
    const feedPart = parts.length > 1 ? parts[parts.length - 1].trim() : '';

    const channelLogo =
      getChannelLogo(name) ||
      getChannelLogo(matchPart) ||
      (feedPart ? getChannelLogo(feedPart) : null);
    if (channelLogo) {
      logos[name] = channelLogo;
      continue;
    }

    const leagueLogo = getLeagueLogo(matchPart, matchPart);
    if (leagueLogo) {
      logos[name] = leagueLogo;
      continue;
    }

    if (extractTeamsFromTitle(matchPart)) asyncTeams.push(name);
    else asyncCatalog.push(name);
  }

  // team crests: bounded list, cached upstream
  await Promise.all(
    asyncTeams.slice(0, 12).map(async (name) => {
      const matchPart = name.split(/\s+—\s+/)[0].trim();
      const teams = extractTeamsFromTitle(matchPart);
      if (!teams) return;
      const logo = (await findTeamLogo(teams[0])) || (await findTeamLogo(teams[1]));
      if (logo) logos[name] = logo;
    })
  );

  // catalog lookups (IPTV channel names → playlist tvg-logo)
  await Promise.all(
    asyncCatalog.slice(0, 20).map(async (name) => {
      const logo = await catalogLogo(name);
      if (logo) logos[name] = logo;
    })
  );

  return NextResponse.json({ logos });
}
