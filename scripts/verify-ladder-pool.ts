// ─────────────────────────────────────────────────────────────────────────────
// Runtime verification of the regenerated LadderAlts pool (Task 2 / Tier 2).
// Runs the REAL production path — findAlternates() from catalog.ts with the
// regenerated data/iptv/LadderAlts.m3u on disk (the Vercel/dev plane) — and
// asserts that DL channel names now resolve quality-rung alternates.
// Bundled + run by verify-ladder-pool.mjs.
// ─────────────────────────────────────────────────────────────────────────────
import { findAlternates, getCatalog } from '../src/lib/iptv/catalog';
import { getLadderPool } from '../src/lib/iptv/ladderpool';
import { matchChannelNames } from '../src/lib/iptv/catalog';

const DL_SAMPLES = [
  'ABC USA', 'CBS USA', 'CNN USA', 'NBC USA', 'FOX USA', 'History USA',
  'NHL Network USA', 'Telemundo', 'Las Estrellas', 'VICE TV',
  'beIN Sports 1 Arabic', 'beIN Sports 5 Arabic', 'Sky Sports Main Event', 'AMC USA',
];

async function main(): Promise<void> {
  const pool = getLadderPool();
  console.log(`pool entries loaded (fs path): ${pool.length}`);
  if (pool.length < 25) throw new Error(`pool too small: ${pool.length}`);

  await getCatalog();

  let pass = 0;
  let fail = 0;
  for (const name of DL_SAMPLES) {
    const alts = await findAlternates(name, '', 10);
    const rungs = alts.filter((a) => a.sameChannel !== false && a.ladder?.length);
    const servers = alts.filter((a) => a.sameChannel === false);
    if (rungs.length) {
      const r = rungs[0];
      console.log(
        `✓ ${name}: rung via ${r.sourceName} [${r.ladder?.join('/')}]` +
          (servers.length ? ` (+${servers.length} manual servers)` : '')
      );
      pass++;
    } else {
      // expected for premium sports (no free ladder sources exist) — but the
      // resolve must still succeed with zero rungs, never throw
      console.log(`· ${name}: no rungs (expected for premium sports) — ${servers.length} manual servers`);
      if (!(name.includes('beIN') || name.includes('Sky') || name === 'AMC USA')) fail++;
    }
  }

  // matcher self-consistency spot checks (the exported match core)
  const t = (w: string, c: string, expectSame: boolean) => {
    const v = matchChannelNames(w, c, 'iptvorg');
    const same = v?.sameChannel === true;
    console.log(`${same === expectSame ? '✓' : '✗'} match("${w}", "${c}") → tier ${v?.tier ?? '-'} same=${same}`);
    if (same !== expectSame) fail++;
  };
  t('ABC USA', 'ABC USA', true); // tier-1 pool emission shape
  t('beIN Sports 1 Arabic', 'beIN Sports 1', false); // region guard: arabic ≠ unqualified
  t('beIN Sports 5 Arabic', 'beIN Sports 5 English', false); // language swap guard
  t('ESPN 2', 'ESPN', false); // number guard
  t('beIN Sports XTRA', 'beIN Sports 1 Arabic', false); // family tier

  console.log(`\n${pass} rung resolutions, ${fail} failures`);
  if (fail > 0) throw new Error('verification failed');
  console.log('RUNTIME VERIFY: PASS');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('RUNTIME VERIFY: FAIL —', e instanceof Error ? e.message : e);
    process.exit(1);
  });
