// ─────────────────────────────────────────────────────────────────────────────
// Build the MaxTV thin API worker bundle (part of the Workers deploy).
//
//   1. bundles + runs scripts/gen-compact-catalog.ts on node (real fs) →
//      public/__snapshots/iptv-compact.json (served as a static asset, so
//      the worker lazy-loads it via the ASSETS binding instead of carrying
//      4MB of JSON inside the bundle)
//   2. esbuild-bundles worker/api-router.ts + the REAL src/ route modules
//      into worker/dist/api.mjs with:
//        • next/server          → worker/shims/next-server.ts (NextResponse/after)
//        • fs/os/path/child_process → worker/shims/* (dead-stub the ffmpeg paths)
//        • crypto/http/https    → external (provided by workerd nodejs_compat)
//        • VERCEL_DEPLOYMENT_ID → "maxtv-workers" (stable cross-isolate HLS
//          signing secret — a random per-isolate secret would 403 every
//          signed /api/hls URL minted by a sibling isolate)
//
// The result runs at ~1-3ms CPU per invocation — the whole point: the
// OpenNext/Next.js server cannot fit the Workers FREE plan CPU budget.
// ─────────────────────────────────────────────────────────────────────────────
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = join(ROOT, 'worker');

mkdirSync(join(workerDir, 'dist'), { recursive: true });

// ── 1. catalog snapshot (node platform — real fs, real path) ────────────────
const genOut = '/tmp/maxtv-gen-catalog.mjs';
await build({
  entryPoints: [join(ROOT, 'scripts', 'gen-compact-catalog.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: genOut,
  tsconfig: join(ROOT, 'tsconfig.json'),
  target: 'node22',
  logLevel: 'warning',
});
execFileSync('node', [genOut], { stdio: 'inherit', cwd: ROOT });

// ── 2. the thin API bundle (workerd-shaped) ──────────────────────────────────
const result = await build({
  entryPoints: [join(workerDir, 'api-router.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(workerDir, 'dist', 'api.mjs'),
  tsconfig: join(ROOT, 'tsconfig.json'),
  alias: {
    'next/server': join(workerDir, 'shims', 'next-server.ts'),
    fs: join(workerDir, 'shims', 'node-fs.ts'),
    'node:fs': join(workerDir, 'shims', 'node-fs.ts'),
    'fs/promises': join(workerDir, 'shims', 'node-fs-promises.ts'),
    'node:fs/promises': join(workerDir, 'shims', 'node-fs-promises.ts'),
    os: join(workerDir, 'shims', 'node-os.ts'),
    'node:os': join(workerDir, 'shims', 'node-os.ts'),
    path: join(workerDir, 'shims', 'node-path.ts'),
    'node:path': join(workerDir, 'shims', 'node-path.ts'),
    child_process: join(workerDir, 'shims', 'node-child_process.ts'),
    'node:child_process': join(workerDir, 'shims', 'node-child_process.ts'),
  },
  external: [
    'crypto', 'node:crypto',
    'http', 'node:http',
    'https', 'node:https',
    'zlib', 'node:zlib',
  ],
  define: {
    // stable cross-isolate HLS signing secret on Workers (Vercel keeps its
    // real deployment id — the define only applies to THIS bundle)
    'process.env.VERCEL_DEPLOYMENT_ID': '"maxtv-workers"',
  },
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

const totalBytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(
  `[build-worker] api bundle → worker/dist/api.mjs (${(totalBytes / 1024).toFixed(0)} KB minified)`
);
