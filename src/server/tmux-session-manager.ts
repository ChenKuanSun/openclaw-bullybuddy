import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync, readSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import type { ISessionManager, SessionInfo, DetailedState, SpawnOptions, TranscriptEntry } from './types.js';
import { StateDetector } from './state-detector.js';
import { stripAnsi } from './utils.js';
import { appendTranscriptEntry } from './transcript.js';
import { SENSITIVE_ENV_KEYS, MAX_SCROLLBACK_BYTES, MAX_SESSIONS, MAX_TRANSCRIPT, DEFAULT_SKIP_PERMISSIONS, isAllowedArg, sanitizeColsRows } from './shared.js';

const SESSION_PREFIX = 'bb-';
const PIPE_DIR = join(homedir(), '.bullybuddy', 'pipes');
const SESSION_META_DIR = join(homedir(), '.bullybuddy', 'sessions');

function tmuxExec(args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf-8', timeout: 5000 }).trim();
}

/** Build env-unsetting args for tmux new-session (strips sensitive vars) */
function makeEnvArgs(): string[] {
  const setEnv: string[] = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    setEnv.push('-e', `${key}=`); // unset in tmux env
  }
  return setEnv;
}

// ── Exit monitoring ─────────────────────────────────────────────────────────
// tmux doesn't push exit events. We poll `tmux list-sessions` to detect exits.
const EXIT_POLL_MS = 2000;

interface ManagedSession {
  info: SessionInfo;
  scrollback: string[];
  scrollbackBytes: number;
  transcript: TranscriptEntry[];
  assistantOutputStart: number;
  pipeCleanup: (() => void) | null;
  pipePath: string;
}

export class TmuxSessionManager extends EventEmitter implements ISessionManager {
  private sessions = new Map<string, ManagedSession>();
  private stateDetector: StateDetector;
  private exitPollTimer: ReturnType<typeof setInterval> | null = null;
  private nameCounter = 0;

  constructor() {
    super();
    this.stateDetector = new StateDetector((sessionId, state, prev) => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.info.detailedState = state;
        if (state === 'compacting') {
          s.info.compactionCount++;
        }
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
        if (state === 'working') {
          s.assistantOutputStart = s.scrollback.length;
        }
        this.emit('stateChange', sessionId, state, prev);
      }
    });

    mkdirSync(PIPE_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(SESSION_META_DIR, { recursive: true, mode: 0o700 });

    // Start exit polling
    this.exitPollTimer = setInterval(() => this.pollExits(), EXIT_POLL_MS);
  }

  private tmuxSessionName(id: string): string {
    return SESSION_PREFIX + id;
  }

  private genId(): string {
    let id: string;
    do {
      id = randomBytes(4).toString('hex');
    } while (this.sessions.has(id));
    return id;
  }

  private autoName(_group: string): string {
    this.nameCounter++;
    return this.nameCounter === 1 ? 'Claude' : `Claude ${this.nameCounter}`;
  }

  spawn(opts: SpawnOptions = {}): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Session limit reached (max ${MAX_SESSIONS})`);
    }

    const id = this.genId();
    const tmuxName = this.tmuxSessionName(id);
    const group = String(opts.group ?? 'default').slice(0, 200);
    const name = String(opts.name ?? this.autoName(group)).slice(0, 200);
    const cwd = opts.cwd ?? process.cwd();
    const cols = sanitizeColsRows(opts.cols, 120);
    const rows = sanitizeColsRows(opts.rows, 40);

    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }

    const args = (opts.args ?? []).filter((a): a is string => typeof a === 'string');
    for (const arg of args) {
      if (!isAllowedArg(arg)) {
        throw new Error(`Unknown argument: ${arg} (add to BB_EXTRA_ARGS to allow)`);
      }
    }

    const skipPerms = opts.skipPermissions ?? DEFAULT_SKIP_PERMISSIONS;
    const DSP = '--dangerously-skip-permissions';
    if (skipPerms && !args.includes(DSP)) {
      args.push(DSP);
    } else if (!skipPerms) {
      const idx = args.indexOf(DSP);
      if (idx !== -1) args.splice(idx, 1);
    }

    // Build the claude command to run inside tmux
    const claudeCmd = ['claude', ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    // Create tmux session (strip sensitive env vars like BB_TOKEN)
    tmuxExec([
      'new-session', '-d',
      '-s', tmuxName,
      '-x', String(cols),
      '-y', String(rows),
      '-c', cwd,
      ...makeEnvArgs(),
      claudeCmd,
    ]);

    // Set up pipe-pane for output streaming
    const pipePath = join(PIPE_DIR, `${id}.pipe`);
    // Create regular file for output (FIFO has blocking issues; use file + watch)
    try { unlinkSync(pipePath); } catch { /* ignore */ }
    closeSync(openSync(pipePath, 'w', 0o600)); // create empty file, owner-only

    tmuxExec(['pipe-pane', '-t', tmuxName, '-o', `cat >> '${pipePath}'`]);

    // Get the PID of the process inside tmux
    let pid: number | null = null;
    try {
      const pidStr = tmuxExec(['list-panes', '-t', tmuxName, '-F', '#{pane_pid}']);
      pid = parseInt(pidStr, 10) || null;
    } catch { /* ignore */ }

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
      pid,
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
      scrollback: [],
      scrollbackBytes: 0,
      transcript: [],
      assistantOutputStart: 0,
      pipeCleanup: null,
      pipePath,
    };

    this.sessions.set(id, managed);
    this.persistMeta(id, info);
    this.startPipeReader(id, managed);
    this.emit('created', info);

    // Auto-send task once Claude reaches idle (with cleanup on exit)
    if (task) {
      const handler = (sid: string, state: DetailedState) => {
        if (sid === id && state === 'idle') {
          this.write(id, task + '\r');
          cleanup();
        }
      };
      const exitHandler = (sid: string) => {
        if (sid === id) cleanup();
      };
      const cleanup = () => {
        this.removeListener('stateChange', handler);
        this.removeListener('exit', exitHandler);
      };
      this.on('stateChange', handler);
      this.on('exit', exitHandler);
    }

    return info;
  }

  /** Start reading output from the pipe file via polling */
  private startPipeReader(id: string, managed: ManagedSession): void {
    let filePos = 0;

    const readNewData = () => {
      let fd: number | null = null;
      try {
        const stat = statSync(managed.pipePath);
        if (stat.size <= filePos) return;
        fd = openSync(managed.pipePath, 'r');
        const buf = Buffer.alloc(stat.size - filePos);
        const bytesRead = readSync(fd, buf, 0, buf.length, filePos);
        filePos += bytesRead;
        if (bytesRead > 0) {
          const data = buf.slice(0, bytesRead).toString('utf-8');
          this.handleOutput(id, managed, data);
        }
      } catch {
        // File may be gone if session was killed
      } finally {
        if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
      }
    };

    // Poll file for new data (50ms — low latency, low overhead)
    const watchInterval = setInterval(readNewData, 50);
    managed.pipeCleanup = () => clearInterval(watchInterval);
  }

  private handleOutput(id: string, managed: ManagedSession, data: string): void {
    managed.scrollback.push(data);
    managed.scrollbackBytes += Buffer.byteLength(data);
    managed.info.lastActivityAt = new Date().toISOString();

    while (managed.scrollbackBytes > MAX_SCROLLBACK_BYTES && managed.scrollback.length > 1) {
      const removed = managed.scrollback.shift()!;
      managed.scrollbackBytes -= Buffer.byteLength(removed);
      if (managed.assistantOutputStart > 0) managed.assistantOutputStart--;
    }

    this.stateDetector.feed(id, data);
    this.emit('output', id, data);
  }

  /** Poll tmux for exited sessions */
  private pollExits(): void {
    let liveSessions: Set<string>;
    try {
      const output = tmuxExec(['list-sessions', '-F', '#{session_name}']);
      liveSessions = new Set(output.split('\n').filter(Boolean));
    } catch {
      // tmux server not running — all sessions are dead
      liveSessions = new Set();
    }

    for (const [id, managed] of this.sessions) {
      if (managed.info.status !== 'running') continue;
      const tmuxName = this.tmuxSessionName(id);
      if (!liveSessions.has(tmuxName)) {
        // Session exited
        managed.info.status = 'exited';
        managed.info.exitCode = null; // tmux doesn't report exit codes via list-sessions
        managed.info.pid = null;

        // Clean up pipe reader
        if (managed.pipeCleanup) {
          managed.pipeCleanup();
          managed.pipeCleanup = null;
        }
        // Clean up pipe file
        try { unlinkSync(managed.pipePath); } catch { /* ignore */ }

        this.stateDetector.remove(id);
        this.emit('exit', id, managed.info.exitCode);
      }
    }
  }

  /** Recover existing tmux sessions on server restart */
  async recover(): Promise<number> {
    let output: string;
    try {
      output = tmuxExec(['list-sessions', '-F', '#{session_name}']);
    } catch {
      return 0; // No tmux server or no sessions
    }

    const tmuxSessions = output.split('\n').filter(s => s.startsWith(SESSION_PREFIX));
    let recovered = 0;

    for (const tmuxName of tmuxSessions) {
      const id = tmuxName.slice(SESSION_PREFIX.length);
      if (this.sessions.has(id)) continue;

      // Try to load persisted metadata
      let info: SessionInfo;
      const metaPath = join(SESSION_META_DIR, `${id}.json`);
      if (existsSync(metaPath)) {
        try {
          info = JSON.parse(readFileSync(metaPath, 'utf-8'));
          info.status = 'running';
          info.detailedState = 'idle'; // assume idle until state detector catches up
        } catch {
          continue;
        }
      } else {
        // Minimal info for sessions without metadata
        let cwd = process.cwd();
        try {
          cwd = tmuxExec(['display-message', '-t', tmuxName, '-p', '#{pane_current_path}']);
        } catch { /* ignore */ }

        let pid: number | null = null;
        try {
          pid = parseInt(tmuxExec(['list-panes', '-t', tmuxName, '-F', '#{pane_pid}']), 10) || null;
        } catch { /* ignore */ }

        const now = new Date().toISOString();
        info = {
          id,
          name: `Recovered ${id}`,
          group: 'recovered',
          cwd,
          status: 'running',
          detailedState: 'idle',
          exitCode: null,
          pid,
          createdAt: now,
          cols: 120,
          rows: 40,
          lastActivityAt: now,
          task: null,
          taskStartedAt: null,
          compactionCount: 0,
          totalWorkingMs: 0,
          totalIdleMs: 0,
          totalPermissionWaitMs: 0,
        };
      }

      const pipePath = join(PIPE_DIR, `${id}.pipe`);
      try { unlinkSync(pipePath); } catch { /* ignore */ }
      closeSync(openSync(pipePath, 'w', 0o600));

      // Re-attach pipe-pane
      try {
        tmuxExec(['pipe-pane', '-t', tmuxName, '-o', `cat >> '${pipePath}'`]);
      } catch {
        try { unlinkSync(pipePath); } catch { /* ignore */ }
        continue; // Skip if we can't attach
      }

      const managed: ManagedSession = {
        info,
        scrollback: [],
        scrollbackBytes: 0,
        transcript: [],
        assistantOutputStart: 0,
        pipeCleanup: null,
        pipePath,
      };

      this.sessions.set(id, managed);
      this.startPipeReader(id, managed);

      // Bootstrap state detector with current pane content
      try {
        const paneContent = tmuxExec(['capture-pane', '-t', tmuxName, '-p', '-S', '-50']);
        if (paneContent) {
          this.stateDetector.feed(id, paneContent);
        }
      } catch { /* ignore */ }

      recovered++;
      console.log(`[bb] recovered session ${id} (${info.name})`);
    }

    return recovered;
  }

  private persistMeta(id: string, info: SessionInfo): void {
    try {
      writeFileSync(join(SESSION_META_DIR, `${id}.json`), JSON.stringify(info), { mode: 0o600 });
    } catch { /* ignore */ }
  }

  setTask(id: string, task: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.info.task = task;
    s.info.taskStartedAt = new Date().toISOString();
    this.persistMeta(id, s.info);
    return true;
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

    const tmuxName = this.tmuxSessionName(id);
    const tmpBuf = join(PIPE_DIR, `input-${id}.tmp`);
    try {
      // Use load-buffer + paste-buffer for binary-safe input
      writeFileSync(tmpBuf, data, { mode: 0o600 });
      tmuxExec(['load-buffer', '-b', `bb-input-${id}`, tmpBuf]);
      tmuxExec(['paste-buffer', '-t', tmuxName, '-b', `bb-input-${id}`, '-d']);
    } catch {
      return false;
    } finally {
      try { unlinkSync(tmpBuf); } catch { /* ignore */ }
    }

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
      s.assistantOutputStart = s.scrollback.length;
    }
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || s.info.status !== 'running') return false;
    const safeCols = sanitizeColsRows(cols, s.info.cols);
    const safeRows = sanitizeColsRows(rows, s.info.rows);
    try {
      tmuxExec(['resize-window', '-t', this.tmuxSessionName(id), '-x', String(safeCols), '-y', String(safeRows)]);
      s.info.cols = safeCols;
      s.info.rows = safeRows;
    } catch {
      return false;
    }
    return true;
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;

    // If already exited (marked by pollExits), just clean up map
    if (s.info.status === 'exited') {
      this.stateDetector.remove(id);
      this.sessions.delete(id);
      return true;
    }

    // Kill tmux session
    try {
      tmuxExec(['kill-session', '-t', this.tmuxSessionName(id)]);
    } catch { /* session may already be dead */ }

    // Clean up pipe reader
    if (s.pipeCleanup) {
      s.pipeCleanup();
      s.pipeCleanup = null;
    }
    // Clean up pipe file and metadata
    try { unlinkSync(s.pipePath); } catch { /* ignore */ }
    try { unlinkSync(join(SESSION_META_DIR, `${id}.json`)); } catch { /* ignore */ }

    this.stateDetector.remove(id);
    this.sessions.delete(id);
    this.emit('exit', id, -1);
    return true;
  }

  killAll(): void {
    // Stop polling BEFORE killing sessions to avoid race
    if (this.exitPollTimer) {
      clearInterval(this.exitPollTimer);
      this.exitPollTimer = null;
    }
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  count(): number {
    return this.sessions.size;
  }
}

/** Check if tmux is available */
export function isTmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { encoding: 'utf-8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
