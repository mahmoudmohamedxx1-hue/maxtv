// ─── node:child_process shim — spawn() can never work on Workers (no
// processes). Every spawn site in the app is defensive: try/catch around
// the call or an 'error' event handler. This stub returns a dead child
// whose 'error' event fires on the next microtask, so:
//   • ffmpegCapable()  → done(false)  → ladder/relay report unavailable
//   • probeHeightBytes() → finish(0)  → nativeHeight gives up gracefully
//   • transcodeSegment() → falls back to the original segment bytes

export interface StubChildProcess {
  pid: number;
  killed: boolean;
  kill(signal?: string): boolean;
  stdout: StubStream;
  stderr: StubStream;
  stdin: StubStream;
  on(event: string, cb: (arg?: unknown) => void): StubChildProcess;
  once(event: string, cb: (arg?: unknown) => void): StubChildProcess;
}

interface StubStream {
  on(event: string, cb: (arg?: unknown) => void): StubStream;
  pipe(): StubStream;
  destroy(): void;
}

function deadStream(): StubStream {
  const s: StubStream = {
    on(_event: string, _cb: (arg?: unknown) => void): StubStream {
      return s;
    },
    pipe(): StubStream {
      return s;
    },
    destroy(): void {
      /* already dead */
    },
  };
  return s;
}

function deadChild(): StubChildProcess {
  const c = {
    pid: -1,
    killed: true,
    kill(): boolean {
      return true;
    },
    stdout: deadStream(),
    stderr: deadStream(),
    stdin: deadStream(),
    on(event: string, cb: (arg?: unknown) => void): StubChildProcess {
      if (event === 'error') {
        queueMicrotask(() => cb(new Error('spawn: processes are not supported on Cloudflare Workers')));
      }
      return c as StubChildProcess;
    },
    once(event: string, cb: (arg?: unknown) => void): StubChildProcess {
      return (c as any).on(event, cb);
    },
  } as StubChildProcess;
  return c;
}

export function spawn(): StubChildProcess {
  return deadChild();
}

export function exec(): never {
  throw new Error('exec: processes are not supported on Cloudflare Workers');
}

export function execFile(): never {
  throw new Error('execFile: processes are not supported on Cloudflare Workers');
}

export function fork(): never {
  throw new Error('fork: processes are not supported on Cloudflare Workers');
}

export default { spawn, exec, execFile, fork };
