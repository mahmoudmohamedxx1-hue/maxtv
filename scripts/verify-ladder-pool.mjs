// esbuild wrapper for scripts/verify-ladder-pool.ts — bundles with @/ aliases
// and runs from the repo root (same pattern as run-ladder-alts.mjs).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/tmp/maxtv-verify-ladder-pool.mjs';

await build({
  entryPoints: [join(ROOT, 'scripts', 'verify-ladder-pool.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: OUT,
  tsconfig: join(ROOT, 'tsconfig.json'),
  target: 'node22',
  logLevel: 'warning',
});

execFileSync('node', [OUT, ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
