// ─── Browser-side segment uncloaking engine ──────────────────────────────────
// Client port of src/lib/streaming/uncloak.ts. The DaddyLive edge CDN serves
// MPEG-TS segments as PNG images (TIKTIKPX pixel steganography) so naive CDNs
// cache them; the server used to unwrap every segment through /api/hls, which
// put a serverless function on the critical path of EVERY 5s segment — the
// measured root cause of the "loads every 5 seconds" rebuffer loop (segments
// arrived in ~15s bursts through the proxy; direct CDN fetches measured
// 940-1700ms for the same 2.6MB).
//
// This module decodes the cloaking IN THE BROWSER (custom hls.js loader):
//   CDN PNG ──▶ DecompressionStream('deflate') (IDAT) ──▶ scanline unfilter
//           ──▶ TIKTIKPX + u32 len + gzip(TS) ──▶ DecompressionStream('gzip')
//           ──▶ clean MPEG-TS ──▶ hls.js
// Zero server hops for segments: ultra-low lag + zero serverless bandwidth.
// The unwrap chain mirrors the server order (WEBP EXIF → PNG IEND → PNG
// pixels → TIKTIKRAW → TIKTIKTSGZ → plain TS scan) so any provider the
// server-side proxy handles also plays client-side.

const TSGZ = [84, 73, 75, 84, 73, 75, 84, 83, 71, 90]; // "TIKTIKTSGZ"
const TRAW = [84, 73, 75, 84, 73, 75, 82, 65, 87]; // "TIKTIKRAW"
const TPIX = [84, 73, 75, 84, 73, 75, 80, 88]; // "TIKTIKPX"

function asciiAt(bytes: Uint8Array, i: number, n: number): string {
  let s = '';
  for (let k = 0; k < n; k++) s += String.fromCharCode(bytes[i + k]);
  return s;
}

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** native async inflate (zlib-wrapped deflate, i.e. what PNG IDAT holds) */
function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')))
    .arrayBuffer()
    .then((b) => new Uint8Array(b));
}

/** native async gunzip */
function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')))
    .arrayBuffer()
    .then((b) => new Uint8Array(b));
}

/** WEBP: RIFF container with an EXIF chunk holding the raw TS (sync — cheap scan) */
export function webpExifTSBrowser(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 16) return null;
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') return null;
  const view = dv(bytes);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const tag = asciiAt(bytes, off, 4);
    const n = view.getUint32(off + 4, true);
    off += 8;
    if (n < 0 || off + n > bytes.length) return null;
    if (tag === 'EXIF') {
      const data = bytes.subarray(off, off + n);
      if (data.length >= 188 && data[0] === 0x47 && data[188] === 0x47) return data;
      return null;
    }
    off += n + (n & 1);
  }
  return null;
}

/** PNG: raw TS appended after the IEND chunk (sync — cheap scan) */
export function pngIendTSBrowser(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 16 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = dv(bytes);
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    if (len > bytes.length - off - 12) return null;
    const type = asciiAt(bytes, off + 4, 4);
    off += 8 + len + 4;
    if (type === 'IEND') {
      if (
        off < bytes.length &&
        bytes[off] === 0x47 &&
        off + 188 < bytes.length &&
        bytes[off + 188] === 0x47
      ) {
        return bytes.subarray(off);
      }
      return null;
    }
  }
  return null;
}

/** Reconstruct PNG pixel rows (filters 0-4 incl. Paeth). RGB/RGBA → RGB.
 *  Pure-JS twin of the server pngRGB — the per-row unfilter loop is ~30-60ms
 *  for a ~2.7MB sports segment on a mid-range phone, far under the segment
 *  duration. Raw scanlines are inflated natively first (DecompressionStream). */
async function pngRGBBrowser(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] === 0x50) return null;
  const view = dv(bytes);
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  const idats: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    if (len > bytes.length - off - 12) return null;
    const type = asciiAt(bytes, off + 4, 4);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      const hd = dv(data);
      w = hd.getUint32(0);
      h = hd.getUint32(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace || (ctype !== 2 && ctype !== 6)) return null;

  const zbuf = new Uint8Array(idats.reduce((n, p) => n + p.length, 0));
  let zoff = 0;
  for (const p of idats) {
    zbuf.set(p, zoff);
    zoff += p.length;
  }
  const raw = await inflate(zbuf);

  const bpp = ctype === 6 ? 4 : 3;
  const stride = w * bpp;
  const rgb = new Uint8Array(w * h * 3);
  let src = 0;
  let dst = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    if (src + 1 + stride > raw.length) return null;
    const filter = raw[src++];
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = raw[src + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) return null;
      recon[i] = v & 255;
    }
    src += stride;
    if (ctype === 2) {
      rgb.set(recon, dst);
      dst += stride;
    } else {
      for (let i = 0; i < stride; i += 4) {
        rgb[dst++] = recon[i];
        rgb[dst++] = recon[i + 1];
        rgb[dst++] = recon[i + 2];
      }
    }
    prev = recon;
  }
  return rgb;
}

/** PNG pixel payload: TIKTIKPX + u32 len + gzip(TS) — the DaddyLive format */
async function unwrapPixelsBrowser(bytes: Uint8Array): Promise<Uint8Array | null> {
  let rgb: Uint8Array;
  try {
    rgb = (await pngRGBBrowser(bytes)) as Uint8Array;
  } catch {
    return null;
  }
  if (!rgb || rgb.length < 12) return null;
  for (let k = 0; k < 8; k++) if (rgb[k] !== TPIX[k]) return null;
  const n = dv(rgb).getUint32(8);
  if (n <= 0 || 12 + n > rgb.length) return null;
  const gz = rgb.subarray(12, 12 + n);
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) return null;
  try {
    const ts = await gunzip(gz);
    if (!ts.length || ts[0] !== 0x47) return null;
    return ts;
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, at: number, magic: number[]): boolean {
  for (let j = 0; j < magic.length; j++) {
    if (bytes[at + j] !== magic[j]) return false;
  }
  return true;
}

/** Full unwrap chain (browser twin of the server unwrapSegment). Async —
 *  the PNG-pixel and gzip paths use DecompressionStream. Returns clean TS,
 *  or null when the payload is a genuine image / undecodable. */
export async function unwrapSegmentBrowser(bytes: Uint8Array): Promise<Uint8Array | null> {
  // fast path: already a clean TS
  if (bytes.length > 188 && bytes[0] === 0x47 && bytes[188] === 0x47) return bytes;

  // 1. WEBP EXIF
  const webp = webpExifTSBrowser(bytes);
  if (webp) return webp;

  // 2. PNG IEND
  const iend = pngIendTSBrowser(bytes);
  if (iend) return iend;

  // 3. PNG pixel steganography (the DaddyLive premium-edge format)
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const px = await unwrapPixelsBrowser(bytes);
    if (px) return px;
    // genuine image (off-air placeholder) → signal unusable
    return null;
  }

  // 4. TIKTIKRAW + raw TS
  for (let i = 0; i + TRAW.length < bytes.length; i++) {
    if (startsWith(bytes, i, TRAW)) {
      const ts = bytes.subarray(i + TRAW.length);
      if (ts.length && ts[0] === 0x47) return ts;
    }
  }

  // 5. TIKTIKTSGZ + gzip
  for (let i = 0; i + TSGZ.length < bytes.length; i++) {
    if (startsWith(bytes, i, TSGZ)) {
      try {
        const ts = await gunzip(bytes.subarray(i + TSGZ.length));
        if (ts.length && ts[0] === 0x47) return ts;
      } catch {
        /* continue */
      }
    }
  }

  // 6. plain TS sync scan
  for (let i = 0; i + 188 < bytes.length; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) {
      return bytes.subarray(i);
    }
  }

  return null;
}
