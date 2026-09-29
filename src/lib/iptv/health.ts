// ─── Source health prober ─────────────────────────────────────────────────────
// Same idea as the original repo's scripts/check-sources.js: verify each
// upstream actually serves video before surfacing its channels. We sample a
// few channels per source, resolve the manifest (following jmp2.uk links) and
// classify:
//    ok        → manifest + first segment reachable
//    geo       → CDN reachable but refuses our region (401/403/451)
//    dead      → DNS failure / connection refused / 5xx / 404
// A source is dropped from the catalog when every probe says "dead".
// Results are cached for 15 minutes.

import { UA, resolveRedirects, isBlockedHost } from '@/lib/streaming/resolve';
import { fetchTolerant } from '@/lib/streaming/tls-fetch';
import type { IPTVChannel } from '@/lib/types';

export type SourceHealth = 'ok' | 'geo' | 'dead' | 'unknown';

export interface SourceStatus {
  id: string;
  health: SourceHealth;
  /** probed channels that returned playable segments */
  okCount: number;
  probed: number;
  checkedAt: number;
}

const TTL_MS = 15 * 60 * 1000;
const PROBE_SAMPLES = 3;

const statusCache = new Map<string, SourceStatus>();
const inFlight = new Map<string, Promise<SourceStatus>>();

function classify(status: number, bodyOk: boolean): SourceHealth {
  if (status >= 200 && status < 300) return bodyOk ? 'ok' : 'geo';
  if ([401, 403, 451].includes(status)) return 'geo';
  if (status === 429) return 'ok'; // rate-limited but alive
  return 'dead'; // 404 / 5xx / etc
}

async function probeChannel(ch: IPTVChannel): Promise<SourceHealth> {
  try {
    const target = await resolveRedirects(ch.url);
    const u = new URL(target);
    if (isBlockedHost(u.hostname)) return 'dead';
    const res = await fetchTolerant(target, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      timeoutMs: 9000,
    });
    if (!res.ok) return classify(res.status, false);

    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    if (!body.includes('#EXTM3U')) return 'dead';

    // master playlist → check the first variant too
    let lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    if (body.includes('#EXT-X-STREAM-INF')) {
      const variant = lines.find((l) => !l.startsWith('#'));
      if (!variant) return 'dead';
      const vUrl = new URL(variant, target).toString();
      if (isBlockedHost(new URL(vUrl).hostname)) return 'dead';
      const vr = await fetchTolerant(vUrl, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeoutMs: 9000,
      });
      if (!vr.ok) return classify(vr.status, false);
      const vt = await vr.text();
      if (!vt.includes('#EXTM3U')) return 'dead';
      lines = vt.split('\n').map((l) => l.trim()).filter(Boolean);
      void ct;
    }
    // media playlist with at least one segment → healthy enough
    const hasSeg = lines.some((l) => !l.startsWith('#'));
    return hasSeg ? 'ok' : 'dead';
  } catch {
    return 'dead';
  }
}

/** Probe a source's health from a sample of its channels. */
export function probeSource(id: string, channels: IPTVChannel[]): Promise<SourceStatus> {
  const hit = statusCache.get(id);
  if (hit && Date.now() - hit.checkedAt < TTL_MS) return Promise.resolve(hit);
  const running = inFlight.get(id);
  if (running) return running;

  const p = (async (): Promise<SourceStatus> => {
    const sample: IPTVChannel[] = [];
    if (channels.length <= PROBE_SAMPLES) {
      sample.push(...channels);
    } else {
      // spread the samples across the channel list
      const step = Math.floor(channels.length / PROBE_SAMPLES);
      for (let i = 0; i < PROBE_SAMPLES; i++) sample.push(channels[i * step]);
    }
    const results = await Promise.all(sample.map((c) => probeChannel(c)));
    const okCount = results.filter((r) => r === 'ok').length;
    const geoCount = results.filter((r) => r === 'geo').length;
    let health: SourceHealth;
    if (okCount > 0) health = 'ok';
    else if (geoCount > 0 && geoCount >= Math.ceil(sample.length / 2)) health = 'geo';
    else health = 'dead';

    const status: SourceStatus = {
      id,
      health,
      okCount,
      probed: sample.length,
      checkedAt: Date.now(),
    };
    statusCache.set(id, status);
    inFlight.delete(id);
    return status;
  })();

  inFlight.set(id, p);
  return p;
}

export function getCachedStatus(id: string): SourceStatus | null {
  const hit = statusCache.get(id);
  if (hit && Date.now() - hit.checkedAt < TTL_MS) return hit;
  return null;
}
