/**
 * Mock IPty that emulates node-pty behavior for tests.
 * Captures writes and allows triggering onData/onExit from tests.
 */
export class MockPty {
  pid = 12345;
  cols: number;
  rows: number;
  process = 'claude';
  handleFlowControl = false;
  spawnArgs: string[];

  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((ev: { exitCode: number; signal?: number }) => void)[] = [];
  written: string[] = [];
  killed = false;

  constructor(args: string[] = [], cols = 120, rows = 40) {
    this.spawnArgs = args;
    this.cols = cols;
    this.rows = rows;
  }

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); } };
  }

  onExit(cb: (ev: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(cb);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb); } };
  }

  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  kill() { this.killed = true; }
  pause() {}
  resume() {}
  clear() {}

  // Test helpers
  emitData(data: string) { for (const cb of this.dataListeners) cb(data); }
  emitExit(exitCode = 0) { for (const cb of this.exitListeners) cb({ exitCode }); }
}

/** Shared array that collects all spawned MockPty instances across test files. */
export const spawnedPtys: MockPty[] = [];

/** node-pty mock factory for vi.mock — reference spawnedPtys from this module. */
export function ptyMockFactory() {
  return {
    default: {
      spawn: (_file: string, args: string[], opts: any) => {
        const pty = new MockPty(args ?? [], opts?.cols ?? 120, opts?.rows ?? 40);
        spawnedPtys.push(pty);
        return pty;
      },
    },
    spawn: (_file: string, args: string[], opts: any) => {
      const pty = new MockPty(args ?? [], opts?.cols ?? 120, opts?.rows ?? 40);
      spawnedPtys.push(pty);
      return pty;
    },
  };
}
