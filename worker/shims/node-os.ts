// ─── node:os shim — only os.tmpdir() is referenced (ffmpeg temp paths).
export default {
  tmpdir: (): string => '/tmp',
  platform: (): string => 'linux',
  EOL: '\n',
  cpus: (): unknown[] => [],
  totalmem: (): number => 0,
  freemem: (): number => 0,
  hostname: (): string => 'workers',
  release: (): string => 'cloudflare-workers',
};
