// ─── M3U / M3U8 playlist parser ─────────────────────────────────────────────
// Parses the #EXTINF format used by IPTV-Scraper-Zilla:
//   #EXTINF:-1 channel-id="x" tvg-id="x" tvg-chno="5" tvg-name="Name" tvg-logo="https://..." group-title="Movies",Display Name
//   https://stream.example/master.m3u8

import type { IPTVChannel } from '../types';

export interface ParsedEntry {
  attrs: Record<string, string>;
  name: string;
  url: string;
}

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

export function parseM3U(content: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const lines = content.split('\n');

  let pending: { attrs: Record<string, string>; name: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      // Attributes live between the first colon and the last comma
      const commaIdx = line.lastIndexOf(',');
      const attrPart = commaIdx >= 0 ? line.slice(line.indexOf(':') + 1, commaIdx) : line.slice(line.indexOf(':') + 1);
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

      const attrs: Record<string, string> = {};
      let m: RegExpExecArray | null;
      ATTR_RE.lastIndex = 0;
      while ((m = ATTR_RE.exec(attrPart)) !== null) {
        attrs[m[1].toLowerCase()] = m[2];
      }
      pending = { attrs, name };
    } else if (!line.startsWith('#')) {
      // URL line
      if (pending) {
        out.push({
          attrs: pending.attrs,
          name: pending.name || pending.attrs['tvg-name'] || 'Unknown',
          url: line,
        });
        pending = null;
      }
    }
  }
  return out;
}

export function entryToChannel(sourceId: string, e: ParsedEntry): IPTVChannel {
  const nativeId = e.attrs['tvg-id'] || e.attrs['channel-id'] || hashString(e.url || e.name);
  return {
    id: `${sourceId}:${nativeId}`,
    name: cleanName(e.name || e.attrs['tvg-name'] || 'Unknown'),
    logo: e.attrs['tvg-logo'] || undefined,
    group: e.attrs['group-title'] || '',
    category: '', // filled by normalizer
    source: sourceId,
    url: e.url,
    tvgId: e.attrs['tvg-id'] || undefined,
    chno: e.attrs['tvg-chno'] || undefined,
  };
}

export function cleanName(name: string): string {
  return name
    .replace(/\\'/g, "'")
    // strip invisible Unicode tag chars (flag-emoji composition bits),
    // variation selectors and zero-width joiners that render as boxes
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}\u{200B}-\u{200D}\u{FEFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
