// State detector: analyzes raw PTY output to determine Claude Code's actual state.
//
// Claude Code emits ANSI-decorated output. We strip control sequences and match
// against known patterns in a sliding window of recent text. The detector is
// fed incremental chunks and maintains per-session state.
//
// Strategy: all patterns are tested against the window, and the one whose match
// appears LATEST (closest to the end) wins. This ensures that the most recent
// output determines the state, even if older patterns are still in the window.

export type DetailedState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'permission_needed'
  | 'compacting'
  | 'error';

import { stripAnsi } from './utils.js';

// How much recent output to keep per session (bytes of plain text)
const WINDOW_SIZE = 2048;

// After this many ms of no output, if we're in 'working' we transition to 'idle'
const IDLE_TIMEOUT_MS = 30_000;

export interface StateMetrics {
  totalWorkingMs: number;
  totalIdleMs: number;
  totalPermissionWaitMs: number;
}

interface SessionState {
  window: string;
  state: DetailedState;
  lastOutputAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stateEnteredAt: number;
  metrics: StateMetrics;
}

type StateChangeCallback = (sessionId: string, state: DetailedState, prev: DetailedState) => void;

// ── Pattern definitions ─────────────────────────────────────────────────────
// Each pattern returns the index of its last match in the window, or -1.

interface Pattern {
  state: DetailedState;
  lastIndex: (window: string) => number;
}

function lastMatchIndex(window: string, regex: RegExp): number {
  let last = -1;
  let m: RegExpExecArray | null;
  // Clone regex with global flag for iterating
  const g = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((m = g.exec(window)) !== null) {
    last = m.index;
    // Avoid infinite loop on zero-length matches
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  return last;
}

function maxIndex(window: string, regexes: RegExp[]): number {
  let best = -1;
  for (const r of regexes) {
    const idx = lastMatchIndex(window, r);
    if (idx > best) best = idx;
  }
  return best;
}

const PATTERNS: Pattern[] = [
  // IDLE — bare prompt at end of output
  {
    state: 'idle',
    lastIndex: (w) => lastMatchIndex(w, /\u276f\s*$/),
  },

  // WORKING — spinners and active processing
  {
    state: 'working',
    lastIndex: (w) => maxIndex(w, [
      /\u273b\s/i,                    // spinner prefix
      /thinking\.\.\./i,
      /working\.\.\./i,
      /channeling\.\.\./i,
      /reading\s+\S+\.\S+/i,
      /writing\s+\S+\.\S+/i,
      /editing\s+\S+\.\S+/i,
      /running\s+\S+/i,
      /searching\s+\S+/i,
    ]),
  },

  // COMPACTING
  {
    state: 'compacting',
    lastIndex: (w) => maxIndex(w, [
      /compacting conversation/i,
      /\u00b7 compacting/i,
    ]),
  },

  // PERMISSION_NEEDED — permission prompts
  {
    state: 'permission_needed',
    lastIndex: (w) => maxIndex(w, [
      /do you want to proceed\??/i,
      /\u23f5\u23f5\s*accept/i,       // accept edits prompt
      /allow\s+(once|always)/i,
      /\(Y\)es\b/i,
      /Yes\s*\/\s*No/i,
      /\bDeny\b.*\bAllow\b/i,
      /press Enter to confirm/i,
      /trust this folder/i,           // trust folder prompt
      /Enter to confirm/i,            // selection confirm prompt
      /Yes, I trust/i,                // trust folder option
      /Quick safety check/i,          // precedes trust folder prompt
      /Bypass Permissions mode/i,     // dangerous permissions mode prompt
      /Yes, I accept/i,               // bypass permissions acceptance option
    ]),
  },

  // ERROR — Claude Code's own error banners (narrow patterns to avoid
  // false positives from code output Claude is displaying/editing)
  {
    state: 'error',
    lastIndex: (w) => maxIndex(w, [
      /^Error:/m,                     // Error at start of line (Claude Code banner)
      /\bAPIError\b/,                 // Anthropic API error
      /\bOverloaded\b/i,             // API overloaded
      /rate limit/i,                  // Rate limiting
      /ENOENT|EACCES|EPERM|ECONNREFUSED/,  // Node.js system errors
      /(?:spawn|exec)\s+\S+\s+ENOENT/,     // Command not found
      /Authentication failed/i,
      /invalid.*api.key/i,
    ]),
  },
];

export class StateDetector {
  private states = new Map<string, SessionState>();
  private onChange: StateChangeCallback;

  constructor(onChange: StateChangeCallback) {
    this.onChange = onChange;
  }

  feed(sessionId: string, rawData: string): void {
    let ss = this.states.get(sessionId);
    if (!ss) {
      const now = Date.now();
      ss = {
        window: '', state: 'starting', lastOutputAt: now, idleTimer: null,
        stateEnteredAt: now,
        metrics: { totalWorkingMs: 0, totalIdleMs: 0, totalPermissionWaitMs: 0 },
      };
      this.states.set(sessionId, ss);
    }

    const plain = stripAnsi(rawData);
    ss.window = (ss.window + plain).slice(-WINDOW_SIZE);
    ss.lastOutputAt = Date.now();

    // Clear any pending idle timer — we just got output
    if (ss.idleTimer) {
      clearTimeout(ss.idleTimer);
      ss.idleTimer = null;
    }

    // Find the pattern with the latest match position (most recent output wins)
    const prev = ss.state;
    let bestState: DetailedState | null = null;
    let bestIndex = -1;

    for (const p of PATTERNS) {
      const idx = p.lastIndex(ss.window);
      if (idx > bestIndex) {
        bestIndex = idx;
        bestState = p.state;
      }
    }

    if (bestState !== null) {
      ss.state = bestState;
    } else if (ss.state === 'starting') {
      // Stay in starting until we see a recognizable pattern
    } else {
      // Got unrecognized output while not starting — likely working
      ss.state = 'working';
    }

    if (ss.state !== prev) {
      this.accumulateTime(ss, prev);
      this.onChange(sessionId, ss.state, prev);
    }

    // Set idle timeout: if we're in 'working', transition to 'idle' after silence
    if (ss.state === 'working') {
      ss.idleTimer = setTimeout(() => {
        ss!.idleTimer = null;
        if (ss!.state === 'working') {
          const p = ss!.state;
          this.accumulateTime(ss!, p);
          ss!.state = 'idle';
          this.onChange(sessionId, 'idle', p);
        }
      }, IDLE_TIMEOUT_MS);
    }
  }

  private accumulateTime(ss: SessionState, prevState: DetailedState): void {
    const now = Date.now();
    const elapsed = now - ss.stateEnteredAt;
    ss.stateEnteredAt = now;
    if (prevState === 'working') ss.metrics.totalWorkingMs += elapsed;
    else if (prevState === 'idle') ss.metrics.totalIdleMs += elapsed;
    else if (prevState === 'permission_needed') ss.metrics.totalPermissionWaitMs += elapsed;
  }

  getState(sessionId: string): DetailedState {
    return this.states.get(sessionId)?.state ?? 'starting';
  }

  getMetrics(sessionId: string): StateMetrics {
    const ss = this.states.get(sessionId);
    if (!ss) return { totalWorkingMs: 0, totalIdleMs: 0, totalPermissionWaitMs: 0 };
    // Include time in current state up to now
    const now = Date.now();
    const elapsed = now - ss.stateEnteredAt;
    const m = { ...ss.metrics };
    if (ss.state === 'working') m.totalWorkingMs += elapsed;
    else if (ss.state === 'idle') m.totalIdleMs += elapsed;
    else if (ss.state === 'permission_needed') m.totalPermissionWaitMs += elapsed;
    return m;
  }

  remove(sessionId: string): void {
    const ss = this.states.get(sessionId);
    if (ss?.idleTimer) clearTimeout(ss.idleTimer);
    this.states.delete(sessionId);
  }
}
