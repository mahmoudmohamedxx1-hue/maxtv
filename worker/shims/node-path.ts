// ─── node:path shim — pure-string implementations of the handful of
// functions the API layer uses (ffmpeg temp paths + playlist data paths).
// No Windows handling: every path in this app is POSIX.

function normalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}

function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p != null && p !== '').join('/'));
}

function resolve(...parts: string[]): string {
  const joined = parts.filter((p) => p != null && p !== '').join('/');
  return normalize(joined.startsWith('/') ? joined : `/${joined}`);
}

function basename(p: string): string {
  const n = normalize(String(p));
  const segs = n.split('/');
  return segs[segs.length - 1] || '/';
}

function dirname(p: string): string {
  const n = normalize(String(p));
  const i = n.lastIndexOf('/');
  if (i <= 0) return i === 0 ? '/' : '.';
  return n.slice(0, i);
}

function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}

export default { join, resolve, basename, dirname, extname, normalize, sep: '/' };
export { join, resolve, basename, dirname, extname, normalize };
