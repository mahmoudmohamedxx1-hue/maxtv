/**
 * Channel health check against a MaxTV deployment (local or Vercel).
 * Samples channels from the catalog and, per kind:
 *   daddylive  → GET /api/sports/stream?channel={ref}
 *   other      → GET /api/iptv/stream?url={ref}
 * then fetches the resolved manifest → must be 200 + #EXTM3U.
 * Usage: node scripts/check-channels.js [baseUrl] [sampleSize]
 */
const BASE = process.argv[2] || 'https://maxtvs.vercel.app';
const SAMPLE = parseInt(process.argv[3] || '20', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(75000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function checkManifest(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    const body = await r.text();
    return { status: r.status, ok: r.status === 200 && body.includes('#EXTM3U'), body: body.slice(0, 160) };
  } catch (e) {
    return { status: 0, ok: false, body: e.message.slice(0, 120) };
  }
}

(async () => {
  console.log(`Target: ${BASE}  (sample ${SAMPLE})`);
  const list = await fetchJson(`${BASE}/api/sports/channels`);
  if (!list.json) {
    console.log('channels endpoint failed:', list.status, list.text.slice(0, 200));
    process.exit(2);
  }
  const channels = Array.isArray(list.json) ? list.json : list.json.channels || [];
  console.log(`Channel catalog: ${channels.length} channels`);

  // spread the sample across the catalog
  const picked = [];
  const step = Math.max(1, Math.floor(channels.length / SAMPLE));
  for (let i = 0; i < channels.length && picked.length < SAMPLE; i += step) picked.push(channels[i]);

  let okCount = 0;
  const failures = [];
  for (const ch of picked) {
    const name = ch.name || ch.id;
    const isDl = (ch.kind || '').startsWith('daddylive') || String(ch.id).startsWith('dl247');
    const api = isDl
      ? `${BASE}/api/sports/stream?channel=${encodeURIComponent(ch.ref)}`
      : `${BASE}/api/iptv/stream?url=${encodeURIComponent(ch.ref)}${ch.name ? `&name=${encodeURIComponent(ch.name)}` : ''}`;
    const res = await fetchJson(api);
    if (res.status !== 200 || !res.json?.url) {
      failures.push(`${name} [${ch.id}]: resolve ${res.status} ${res.json?.error || res.text.slice(0, 60)}`);
      console.log(`  ✗ ${name} — resolve failed ${res.status} ${res.json?.error || ''}`);
      continue;
    }
    const streamUrl = res.json.url.startsWith('http') ? res.json.url : BASE + res.json.url;
    const m = await checkManifest(streamUrl);
    if (m.ok) {
      okCount++;
      console.log(`  ✓ ${name} — manifest OK`);
    } else {
      failures.push(`${name} [${ch.id}]: manifest ${m.status} ${m.body.replace(/\n/g, ' ').slice(0, 90)}`);
      console.log(`  ✗ ${name} — manifest ${m.status}`);
    }
    await sleep(250);
  }

  console.log(`\n===== ${BASE} =====`);
  console.log(`Working: ${okCount}/${picked.length}  (${Math.round((okCount / picked.length) * 100)}%)`);
  if (failures.length) {
    console.log('Failing channels:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(2);
});
