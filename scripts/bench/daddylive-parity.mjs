// ─────────────────────────────────────────────────────────────────────────────
// daddylive-parity.mjs — pins the string-op parsers (parseScheduleHtml /
// parse247Html) to the OUTPUT of the cheerio walkers they replaced.
//
// WHY: the cheerio parses burned 60-150ms CPU on the real mirror pages —
// 6-15x the Workers free-plan 10ms/invocation budget — killing the catalog
// routes on every cold isolate ("site broken again", 4x running; see the
// note atop src/lib/sports/daddylive.ts). The fast walkers must produce the
// SAME output; this script proves it on captured REAL pages.
//
// RUN:  SCHEDULE_SAMPLE=/path/schedule.html PAGE247_SAMPLE=/path/247.html \
//       bun scripts/bench/daddylive-parity.mjs
//
// Capture fresh samples with:
//   curl -s https://dlive.sx/ -H 'User-Agent: Mozilla/5.0' -o schedule.html
//   curl -s https://dlive.sx/24-7-channels.php -H 'User-Agent: Mozilla/5.0' -o 247.html
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import {
  parseScheduleHtml,
  parse247Html,
  DURATIONS,
  isWomensCompetition,
} from '../../src/lib/sports/daddylive';
import {
  splitLeague,
  stripEmojis,
  decodeEntities,
  isEventStream,
} from '../../src/lib/sports/categories';
import { normalizeSport } from '../../src/lib/sports/categories';

function refParseSchedule(html) {
  const $ = cheerio.load(html);
  const out = [];
  const now = Date.now();
  const currentYear = new Date().getUTCFullYear();
  const seen = new Set();
  const fixMojibake = (n) => n.replace(/Espa単ol/g, 'Español');

  $('.schedule__day').each((_, dayEl) => {
    const $day = $(dayEl);
    const dayTitle = $day.find('.schedule__dayTitle').first().text().trim();
    const dateMatch = dayTitle.match(/(\d+)(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
    const year = dateMatch && dateMatch[3] ? parseInt(dateMatch[3], 10) : currentYear;
    let dayStr = '';
    if (dateMatch) dayStr = `${dateMatch[1]} ${dateMatch[2]} ${year}`;

    $day.find('.schedule__category').each((_, catEl) => {
      const $cat = $(catEl);
      const rawCat = $cat.find('.card__meta').first().text().trim();
      const cleanCat = stripEmojis(decodeEntities(rawCat));
      if (!cleanCat || /big brother/i.test(cleanCat)) return;

      $cat.find('.schedule__event').each((__, evEl) => {
        const $ev = $(evEl);
        const time = ($ev.find('.schedule__time').attr('data-time') || $ev.find('.schedule__time').text() || '').trim();
        const rawTitle = $ev.find('.schedule__eventTitle').first().text().trim();
        if (!rawTitle || !time) return;

        const channels = [];
        const seenCh = new Set();
        $ev.find('.schedule__channels a').each((___, a) => {
          const href = $(a).attr('href') || '';
          const idm = href.match(/id=(\d+)/);
          if (!idm || idm[1] === '00') return;
          const id = idm[1];
          if (seenCh.has(id)) return;
          seenCh.add(id);
          const name = ($(a).attr('title') || $(a).text() || `Channel ${id}`).trim();
          channels.push({ id, name: fixMojibake(decodeEntities(name)) || `Channel ${id}` });
        });
        if (channels.length === 0) return;

        const rawEvent = stripEmojis(decodeEntities(rawTitle));
        const { league, title } = splitLeague(rawEvent);
        const category = normalizeSport(`${cleanCat} ${league} ${title}`);

        let matchTime = null;
        const explicitDate = rawEvent.match(
          /(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?/i
        );
        if (cleanCat.toLowerCase().includes('upcoming') && explicitDate) {
          const y = explicitDate[3] ? parseInt(explicitDate[3], 10) : year;
          const parsed = Date.parse(`${explicitDate[1]} ${explicitDate[2]} ${y} ${time}:00 UTC`);
          if (!Number.isNaN(parsed)) matchTime = parsed;
        }
        if (matchTime == null && dayStr) {
          const parsed = Date.parse(`${dayStr} ${time}:00 UTC`);
          if (!Number.isNaN(parsed)) {
            matchTime = time < '06:00' ? parsed + 24 * 3600_000 : parsed;
          }
        }
        if (matchTime == null) return;

        const maxDuration = DURATIONS[category] ?? 3 * 3600_000;
        if (now > matchTime + maxDuration) return;

        const dedup = `${title}|${matchTime}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);

        out.push({
          id: `dl_${matchTime}_${title.replace(/\W+/g, '').slice(0, 40).toLowerCase()}`,
          title,
          league: league || cleanCat,
          category,
          startTime: matchTime,
          timeStr: time,
          status: now >= matchTime && now <= matchTime + maxDuration ? 'live' : 'upcoming',
          channels,
          day: dayTitle,
          women: isWomensCompetition(`${league} ${cleanCat}`),
        });
      });
    });
  });
  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}

function refParse247(html) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  const fixMojibake = (n) => n.replace(/Espa単ol/g, 'Español');
  $('a.card').each((_, el) => {
    const href = $(el).attr('href') || '';
    const idm = href.match(/id=(\d+)/);
    if (!idm) return;
    const id = idm[1];
    if (seen.has(id)) return;
    seen.add(id);
    const name = ($(el).find('.card__title').first().text() || $(el).attr('data-title') || `Channel ${id}`).trim();
    if (!name || isEventStream(name)) return;
    out.push({ id, name: fixMojibake(decodeEntities(name)) });
  });
  return out;
}


// ── diff harness ────────────────────────────────────────────────────────────
function deepDiff(a, b, path = '') {
  const diffs = [];
  if (Array.isArray(a) !== Array.isArray(b)) {
    diffs.push(`${path}: type ${Array.isArray(a) ? 'array' : typeof a} vs ${Array.isArray(b) ? 'array' : typeof b}`);
    return diffs;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${path}: length ${a.length} vs ${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    return diffs;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) diffs.push(`${path}.${k}: missing in OLD`);
      else if (!(k in b)) diffs.push(`${path}.${k}: missing in NEW`);
      else diffs.push(...deepDiff(a[k], b[k], `${path}.${k}`));
    }
    return diffs;
  }
  if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return diffs;
}

function main() {
  const schedPath = process.env.SCHEDULE_SAMPLE;
  const page247Path = process.env.PAGE247_SAMPLE;
  let fail = 0;

  if (schedPath) {
    const html = readFileSync(schedPath, 'utf8');
    const t0 = performance.now();
    const oldOut = refParseSchedule(html);
    const t1 = performance.now();
    const newOut = parseScheduleHtml(html);
    const t2 = performance.now();
    console.log(`[schedule] old(cheerio): ${oldOut.length} matches in ${(t1 - t0).toFixed(1)}ms`);
    console.log(`[schedule] new(string): ${newOut.length} matches in ${(t2 - t1).toFixed(1)}ms`);
    const d = deepDiff(oldOut, newOut, 'sched');
    if (d.length) {
      fail++;
      console.log(`[schedule] PARITY FAIL — ${d.length} diffs; first 12:`);
      d.slice(0, 12).forEach((x) => console.log('  -', x));
    } else console.log('[schedule] PARITY OK');
  } else console.log('[schedule] SCHEDULE_SAMPLE not set — skipped');

  if (page247Path) {
    const html = readFileSync(page247Path, 'utf8');
    const t0 = performance.now();
    const oldOut = refParse247(html);
    const t1 = performance.now();
    const newOut = parse247Html(html);
    const t2 = performance.now();
    console.log(`[247] old(cheerio): ${oldOut.length} channels in ${(t1 - t0).toFixed(1)}ms`);
    console.log(`[247] new(string): ${newOut.length} channels in ${(t2 - t1).toFixed(1)}ms`);
    const d = deepDiff(oldOut, newOut, 'p247');
    if (d.length) {
      fail++;
      console.log(`[247] PARITY FAIL — ${d.length} diffs; first 12:`);
      d.slice(0, 12).forEach((x) => console.log('  -', x));
    } else console.log('[247] PARITY OK');
  } else console.log('[247] PAGE247_SAMPLE not set — skipped');

  process.exit(fail ? 1 : 0);
}

main();
