'use client';

// ─── UncloakDirectLoader — hls.js fragment loader with CDN-direct playback ───
// The 2026-10-21 "loads every 5 seconds" root cause: every DaddyLive segment
// was proxied through a Vercel function (/api/hls → unwrap → browser), which
// added seconds of latency and burst-shaped delivery on the critical path —
// the buffer drained at every other segment window no matter which quality
// was selected (measured on production: ABR already at 144p and STILL
// rebuffering every ~15s; the same segments fetched directly from the TikTok
// CDN take 940-1700ms).
//
// This loader takes the segment URLs our /api/hls ladder playlist mints as
// `/api/segdl?u=<absolute-cdn-url>` and resolves them CLIENT-SIDE:
//   1. fetch <u> directly from the CDN (CORS-open, no token, any IP)
//   2. unwrap the PNG/WEBP steganography in-browser (uncloak-browser.ts)
//   3. hand the clean TS to hls.js
// Any failure (CORS shift, format change, decode error) falls back to the
// SAME /api/segdl URL via the normal network path — the server route fetches
// + unwraps + serves, i.e. the exact legacy behavior. Per-segment fallback,
// zero player-visible difference beyond the speed.
//
// Non-segdl URLs (manifests, turbo-transcoded rungs, every other source)
// pass straight through to the default XhrLoader untouched.

import Hls from 'hls.js';
import { unwrapSegmentBrowser } from '@/lib/player/uncloak-browser';

const SEGDL_MARK = '/api/segdl?u=';

/** CDN hosts whose segments are CORS-readable and cloaked — the direct path
 *  only engages for these (the segdl route allowlists the same hosts
 *  server-side, so client and server fallback agree on what's eligible). */
const DIRECT_HOSTS = ['tiktokcdn-us.com', 'tiktokcdn.com', 'tiktokcdn-eu.com', 'tiktokv.us'];

function isDirectHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return DIRECT_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** extract ?u= from a same-origin /api/segdl URL (works for relative and
 *  absolute forms — hls.js resolves playlist URLs against the page) */
function segdlTarget(url: string): string | null {
  const i = url.indexOf(SEGDL_MARK);
  if (i === -1) return null;
  const q = url.slice(i + SEGDL_MARK.length);
  const u = new URLSearchParams(q).get('u') || decodeURIComponent(q.split('&')[0]);
  return /^https?:\/\//i.test(u) ? u : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any — hls.js loader types are
   structural; we mirror the LoaderCallbacks/LoaderStats shapes by hand. */

export class UncloakDirectLoader extends (Hls.DefaultConfig.loader as any) {
  private __abortCtrl: AbortController | null = null;

  load(context: any, config: any, callbacks: any): void {
    const url: string = context?.url || '';
    if (context?.type === 'fragment' && url.includes(SEGDL_MARK)) {
      const target = segdlTarget(url);
      if (target && isDirectHost(target) && typeof DecompressionStream !== 'undefined') {
        void this.__loadDirect(context, config, callbacks, target);
        return;
      }
    }
    super.load(context, config, callbacks);
  }

  abort(): void {
    this.__abortCtrl?.abort();
    this.__abortCtrl = null;
    super.abort();
  }

  private async __loadDirect(
    context: any,
    config: any,
    callbacks: any,
    target: string
  ): Promise<void> {
    const start = performance.now();
    const ctrl = new AbortController();
    this.__abortCtrl = ctrl;
    let directOk = false;
    try {
      const res = await fetch(target, {
        cache: 'no-store',
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`cdn ${res.status}`);
      const raw = new Uint8Array(await res.arrayBuffer());
      const firstByte = performance.now();
      if (raw.length < 188) throw new Error('empty segment');
      // clean TS passes through; cloaked payloads unwrap in-browser
      const ts =
        raw[0] === 0x47 && raw[188] === 0x47 ? raw : ((await unwrapSegmentBrowser(raw)) as Uint8Array | null);
      if (!ts || ts.length < 188) throw new Error('unwrap failed');
      const end = performance.now();

      const stats = {
        aborted: false,
        loaded: ts.length,
        retry: 0,
        total: ts.length,
        chunkCount: 1,
        bwEstimate: 0,
        loading: { start, first: firstByte, end },
        parsing: { start: end, first: end, end },
        buffering: { start: end, first: end, end },
      };
      // segment response — hls.js accepts Uint8Array fragment payloads
      directOk = true;
      callbacks.onSuccess({ url: context.url, data: ts }, stats, context, null);
    } catch {
      /* fall through to the server fallback below */
    } finally {
      if (this.__abortCtrl === ctrl) this.__abortCtrl = null;
    }
    if (!directOk && !ctrl.signal.aborted) {
      // any failure → the server-side segdl route (fetch + unwrap + serve —
      // the exact legacy proxy behavior, on the same URL the player holds)
      try {
        super.load(context, config, callbacks);
      } catch {
        /* loader destroyed mid-switch — nothing to do */
      }
    }
  }
}
