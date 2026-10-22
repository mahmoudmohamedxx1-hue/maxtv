// ─── node:fs/promises shim — the only consumer is transcode.ts's async
// temp-file helpers, which are unreachable on Workers (no ffmpeg). Every
// method resolves or rejects defensively; nothing throws synchronously.
export default {
  mkdtemp: async (prefix: string): Promise<string> =>
    `/tmp/${String(prefix).replace(/[^a-z0-9-]/gi, '')}-${Date.now()}`,
  writeFile: async (): Promise<void> => {
    /* in-memory fs — writes are not observable */
  },
  readFile: async (p: string): Promise<string> => {
    throw new Error(`ENOENT: ${p}`);
  },
  rm: async (): Promise<void> => {
    /* best effort no-op */
  },
  stat: async (p: string): Promise<never> => {
    throw new Error(`ENOENT: ${p}`);
  },
  mkdir: async (): Promise<void> => {
    /* implicit */
  },
};
