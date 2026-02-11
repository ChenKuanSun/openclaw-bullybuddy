import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import { EventEmitter } from 'events';
import type { SessionInfo, SessionStatus, DetailedState, SpawnOptions, TranscriptEntry } from './types.js';
import { StateDetector } from './state-detector.js';
import { stripAnsi } from './utils.js';
import { appendTranscriptEntry } from './transcript.js';

const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_SESSIONS = 100;
const MAX_TRANSCRIPT = parseInt(process.env.BB_TRANSCRIPT_SIZE ?? '500', 10);

// Env vars to strip from child processes
const SENSITIVE_ENV_KEYS = ['BB_TOKEN', 'BB_HOST', 'BB_PORT'];

// Whether to auto-add --dangerously-skip-permissions (default: true for backward compat)
const DEFAULT_SKIP_PERMISSIONS = process.env.BB_SKIP_PERMISSIONS?.toLowerCase() !== 'false';

// Allowed claude CLI flags (allowlist approach — block unknown args for safety)
const ALLOWED_FLAGS = new Set([
  '--model', '-m',
  '--print', '-p',
  '--resume', '-r',
  '--continue', '-c',
  '--dangerously-skip-permissions',
  '--verbose',
  '--version',
]);

// Additional flags from env (comma-separated, e.g. BB_EXTRA_ARGS="--output-format,--max-turns")
if (process.env.BB_EXTRA_ARGS) {
  for (const f of process.env.BB_EXTRA_ARGS.split(',')) {
    const trimmed = f.trim();
    if (trimmed) ALLOWED_FLAGS.add(trimmed);
  }
}

function isAllowedArg(arg: string): boolean {
  // Exact match: --verbose, -p, etc.
  if (ALLOWED_FLAGS.has(arg)) return true;
  // Flag=value form: --model=sonnet, check the flag part
  if (arg.includes('=')) {
    const flag = arg.slice(0, arg.indexOf('='));
    if (ALLOWED_FLAGS.has(flag)) return true;
  }
  // Positional/value args (not starting with -) are allowed — they follow a flag.
  // The allowlist blocks unknown flags; positional values are validated by the claude CLI itself.
  if (!arg.startsWith('-')) return true;
  return false;
}

function sanitizeColsRows(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.round(value)));
}

function makeChildEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of SENSITIVE_ENV_KEYS) delete env[key];
  return env;
}

interface ManagedSession {
  info: SessionInfo;
  pty: pty.IPty;
  scrollback: string[];
  scrollbackBytes: number;
  transcript: TranscriptEntry[];
  assistantOutputStart: number; // index into scrollback where current assistant output began
  disposables: { dispose(): void }[];
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private stateDetector: StateDetector;

  constructor() {
    super();
    this.stateDetector = new StateDetector((sessionId, state, prev) => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.info.detailedState = state;
        if (state === 'compacting') {
          s.info.compactionCount++;
        }
        // Capture assistant response on working→idle transition
        if (state === 'idle' && prev === 'working') {
          const output = s.scrollback.slice(s.assistantOutputStart).join('');
          const content = stripAnsi(output).trim();
          if (content) {
            const entry: TranscriptEntry = {
              timestamp: new Date().toISOString(),
              role: 'assistant',
              content,
            };
            s.transcript.push(entry);
            if (s.transcript.length > MAX_TRANSCRIPT) {
              s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT);
            }
            appendTranscriptEntry(sessionId, entry);
          }
        }
        // Mark start of next assistant output when entering working state
        if (state === 'working') {
          s.assistantOutputStart = s.scrollback.length;
        }
        this.emit('stateChange', sessionId, state, prev);
      }
    });
  }

  private genId(): string {
    let id: string;
    do {
      id = randomBytes(4).toString('hex');
    } while (this.sessions.has(id));
    return id;
  }

  private nameCounter = 0;

  /** Auto-generate a unique name: "Claude", "Claude 2", "Claude 3", ... (never reuses) */
  private autoName(_group: string): string {
    this.nameCounter++;
    return this.nameCounter === 1 ? 'Claude' : `Claude ${this.nameCounter}`;
  }

  spawn(opts: SpawnOptions = {}): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (max ${MAX_SESSIONS})`);
    }

    const id = this.genId();
    const group = String(opts.group ?? 'default').slice(0, 200);
    const name = String(opts.name ?? this.autoName(group)).slice(0, 200);
    const cwd = opts.cwd ?? process.cwd();
    const cols = sanitizeColsRows(opts.cols, 120);
    const rows = sanitizeColsRows(opts.rows, 40);

    // Validate cwd
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }

    // Validate args against allowlist
    const args = (opts.args ?? []).filter((a): a is string => typeof a === 'string');
    for (const arg of args) {
      if (!isAllowedArg(arg)) {
        throw new Error(`Unknown argument: ${arg} (add to BB_EXTRA_ARGS to allow)`);
      }
    }

    // Auto-add --dangerously-skip-permissions unless disabled
    const skipPerms = opts.skipPermissions ?? DEFAULT_SKIP_PERMISSIONS;
    const DSP = '--dangerously-skip-permissions';
    if (skipPerms && !args.includes(DSP)) {
      args.push(DSP);
    } else if (!skipPerms) {
      const idx = args.indexOf(DSP);
      if (idx !== -1) args.splice(idx, 1);
    }

    const shell = 'claude';
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: makeChildEnv(),
    });

    const now = new Date().toISOString();
    const task = typeof opts.task === 'string' && opts.task.trim() ? opts.task.trim() : null;
    const info: SessionInfo = {
      id,
      name,
      group,
      cwd,
      status: 'running',
      detailedState: 'starting',
      exitCode: null,
      pid: ptyProcess.pid,
      createdAt: now,
      cols,
      rows,
      lastActivityAt: now,
      task,
      taskStartedAt: task ? now : null,
      compactionCount: 0,
      totalWorkingMs: 0,
      totalIdleMs: 0,
      totalPermissionWaitMs: 0,
    };

    const managed: ManagedSession = {
      info,
      pty: ptyProcess,
      scrollback: [],
      scrollbackBytes: 0,
      transcript: [],
      assistantOutputStart: 0,
      disposables: [],
    };

    this.sessions.set(id, managed);

    managed.disposables.push(
      ptyProcess.onData((data: string) => {
        managed.scrollback.push(data);
        managed.scrollbackBytes += Buffer.byteLength(data);
        managed.info.lastActivityAt = new Date().toISOString();
        // Evict from front when total exceeds MAX_SCROLLBACK_BYTES
        while (managed.scrollbackBytes > MAX_SCROLLBACK_BYTES && managed.scrollback.length > 1) {
          const removed = managed.scrollback.shift()!;
          managed.scrollbackBytes -= Buffer.byteLength(removed);
          // Adjust assistantOutputStart when entries are evicted
          if (managed.assistantOutputStart > 0) managed.assistantOutputStart--;
        }
        this.stateDetector.feed(id, data);
        this.emit('output', id, data);
      }),
    );

    managed.disposables.push(
      ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        managed.info.status = 'exited';
        managed.info.exitCode = exitCode;
        managed.info.pid = null;
        this.emit('exit', id, exitCode);
      }),
    );

    this.emit('created', info);

    // Auto-send task as first input once Claude reaches idle prompt
    if (task) {
      const handler = (sid: string, state: DetailedState) => {
        if (sid === id && state === 'idle') {
          this.write(id, task + '\r');
          this.removeListener('stateChange', handler);
        }
      };
      this.on('stateChange', handler);
      managed.disposables.push({ dispose: () => this.removeListener('stateChange', handler) });
    }

    return info;
  }

  setTask(id: string, task: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.info.task = task;
    s.info.taskStartedAt = new Date().toISOString();
    return true;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  getInfo(id: string): SessionInfo | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    this.syncMetrics(s);
    return s.info;
  }

  private syncMetrics(s: ManagedSession): void {
    const m = this.stateDetector.getMetrics(s.info.id);
    s.info.totalWorkingMs = m.totalWorkingMs;
    s.info.totalIdleMs = m.totalIdleMs;
    s.info.totalPermissionWaitMs = m.totalPermissionWaitMs;
  }

  getScrollback(id: string): string[] {
    const sb = this.sessions.get(id)?.scrollback;
    return sb ? [...sb] : [];
  }

  getTranscript(id: string): TranscriptEntry[] {
    return this.sessions.get(id)?.transcript ?? [];
  }

  list(group?: string): SessionInfo[] {
    for (const s of this.sessions.values()) this.syncMetrics(s);
    const all = Array.from(this.sessions.values()).map((s) => s.info);
    if (group) return all.filter((s) => s.group === group);
    return all;
  }

  groups(): Map<string, SessionInfo[]> {
    const map = new Map<string, SessionInfo[]>();
    for (const s of this.sessions.values()) {
      this.syncMetrics(s);
      const g = s.info.group;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s.info);
    }
    return map;
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.info.status !== 'running') return false;
    s.pty.write(data);
    // Record user input in transcript
    const content = data.replace(/\r$/, '');
    if (content) {
      const entry: TranscriptEntry = {
        timestamp: new Date().toISOString(),
        role: 'user',
        content,
      };
      s.transcript.push(entry);
      if (s.transcript.length > MAX_TRANSCRIPT) {
        s.transcript.splice(0, s.transcript.length - MAX_TRANSCRIPT);
      }
      appendTranscriptEntry(id, entry);
      // Mark where assistant output will start (after current scrollback)
      s.assistantOutputStart = s.scrollback.length;
    }
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.info.status !== 'running') return false;
    const safeCols = sanitizeColsRows(cols, s.info.cols);
    const safeRows = sanitizeColsRows(rows, s.info.rows);
    s.pty.resize(safeCols, safeRows);
    s.info.cols = safeCols;
    s.info.rows = safeRows;
    return true;
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    for (const d of s.disposables) d.dispose();
    s.disposables.length = 0;
    if (s.info.status === 'running') {
      s.pty.kill();
    }
    this.stateDetector.remove(id);
    this.sessions.delete(id);
    // Emit exit event so WS clients can update (e.g., show dead lobster)
    this.emit('exit', id, -1); // -1 indicates killed (not natural exit)
    return true;
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  count(): number {
    return this.sessions.size;
  }
}
