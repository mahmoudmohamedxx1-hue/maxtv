// ─────────────────────────────────────────────────────────────────────────────
// esbuild wrapper for scripts/build-ladder-alts.ts (the pool generator).
// Bundles the TS (with its @/ alias imports) to /tmp, then runs it from the
// repo root so relative data/ paths resolve — same pattern build-worker.mjs
// uses for gen-compact-catalog.ts. All CLI flags pass through.
//
//   node scripts/run-ladder-alts.mjs [--dl-json <file>] [--dry-run] …
// ─────────────────────────────────────────────────────────────────────────────
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/tmp/maxtv-gen-ladder-alts.mjs';

await build({
  entryPoints: [join(ROOT, 'scripts', 'build-ladder-alts.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  tsconfig: join(ROOT, 'tsconfig.json'),
  target: 'node22',
  logLevel: 'warning',
});

execFileSync('node', [OUT, ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
