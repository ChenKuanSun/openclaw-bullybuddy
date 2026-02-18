# Session Stability Analysis & tmux Migration Plan

## Why Sessions Crash — Root Cause Analysis

### 1. Server Death = All Sessions Die (Critical)

```
BullyBuddy Server (Node.js)
  └── claude session 1 (child process via node-pty)
  └── claude session 2 (child process via node-pty)
  └── claude session 3 (child process via node-pty)
```

`pty.spawn()` creates Claude Code as a direct child process of the Node.js server. When the server exits for any reason, the OS sends SIGHUP to all children, killing every session.

Triggers:
- Server OOM (see #2)
- Unhandled exception in Node.js
- Manual restart / deploy
- OS killing the process (e.g. macOS memory pressure)
- `node-pty` native addon segfault (see #3)

**Impact:** All running sessions destroyed instantly. No recovery possible.

**Location:** `session-manager.ts:165` — `pty.spawn(shell, args, { ... })`

### 2. Memory Pressure from Scrollback Buffers (High)

```
MAX_SCROLLBACK_BYTES = 2MB per session
MAX_SESSIONS = 100
Worst case: 100 × 2MB = 200MB scrollback alone
```

Each session accumulates output in a `string[]` array (`session-manager.ts:199`). The eviction logic (`session-manager.ts:214`) uses `Array.shift()` in a while loop, which is O(n) on each eviction and causes GC pressure from fragmented string allocations.

Additionally, `getScrollback()` (`session-manager.ts:278`) clones the entire array with spread (`[...sb]`), doubling memory momentarily when a WS client subscribes and receives scrollback (`ws-bridge.ts:114-121`).

Combined with Node.js heap overhead, 30-50 active sessions can push the process past typical memory limits.

### 3. node-pty Native Addon Crashes (Medium)

`node-pty` includes compiled C++ code (`node_modules/node-pty/`). Native addon crashes (segfaults, buffer overflows) bypass Node.js error handling entirely — they kill the process with no stack trace and no recovery.

Known issues:
- Rapid resize events can trigger race conditions in the native layer
- Writing to a PTY after the child has exited but before `onExit` fires
- Platform-specific fd leak on macOS under high session churn

### 4. State Detector Regex CPU Spikes (Medium)

Every PTY output chunk runs through all regex patterns in the state detector (`state-detector.ts:178-184`). Each pattern call uses `lastMatchIndex()` which iterates all matches with a global regex.

For a 2KB window with 5 pattern groups containing ~20 total regexes, each chunk triggers ~20 regex scans over 2KB. During heavy Claude Code output (e.g. large file edits), hundreds of chunks per second can arrive, causing CPU spikes that starve the event loop.

When the event loop is starved:
- WS messages queue up and time out
- HTTP health checks fail
- Timers drift (idle detection breaks)
- PTY output buffers in the kernel, eventually causing backpressure

**Location:** `state-detector.ts:151-212`

### 5. No Watchdog for Zombie Sessions (Medium)

If a Claude Code process hangs (e.g. stuck in a compaction loop, waiting on a stalled API call), BullyBuddy has no mechanism to detect or recover from it. The session sits in `working` state forever (or until the 30s idle timeout, which won't fire because there's no output silence — just no useful output).

No heartbeat, no health check, no auto-restart.

### 6. WebSocket Backpressure (Low-Medium)

`ws-bridge.ts:79-85` buffers output with a 16ms coalescing timer, but doesn't check WS send buffer size. If a client has slow connectivity (common with tunnel), `ws.send()` queues data in the `ws` library's internal buffer without bound. Enough sessions with fast output can exhaust memory.

### 7. Event Listener Leak on Task Auto-Send (Low)

```typescript
// session-manager.ts:237-246
if (task) {
  const handler = (sid: string, state: DetailedState) => {
    if (sid === id && state === 'idle') {
      this.write(id, task + '\r');
      this.removeListener('stateChange', handler);
    }
  };
  this.on('stateChange', handler);
}
```

If a session exits before reaching `idle` state, the handler is cleaned up via `disposables` — but only if `kill()` is called. If the PTY exits naturally (e.g. Claude Code crashes on startup), the `onExit` handler does NOT call `dispose()` on the task handler. The listener remains registered on the EventEmitter, firing on every subsequent `stateChange` event for all sessions, comparing `sid === id` for a dead session.

With many failed spawns, these leaked listeners accumulate and slow down all state change processing.

---

## tmux Migration Architecture

### Current vs Proposed

```
CURRENT (node-pty):
┌─────────────────────┐
│  BullyBuddy Server  │
│  ┌───────────────┐  │
│  │ node-pty PTY  │──── claude (child process, dies with server)
│  │ onData stream │  │
│  └───────────────┘  │
└─────────────────────┘

PROPOSED (tmux):
┌─────────────────────┐       ┌──────────────────────┐
│  BullyBuddy Server  │       │  tmux server         │
│  ┌───────────────┐  │       │  ┌────────────────┐  │
│  │ pipe-pane     │◄─────────│  │ session bb-abc │──── claude (independent process)
│  │ output stream │  │       │  │ session bb-def │──── claude (survives server crash)
│  └───────────────┘  │       │  └────────────────┘  │
└─────────────────────┘       └──────────────────────┘
```

### Core Operations Mapping

| Operation | node-pty (current) | tmux (proposed) |
|-----------|-------------------|-----------------|
| Spawn | `pty.spawn('claude', args)` | `tmux new-session -d -s bb-<id> 'claude <args>'` |
| Input | `pty.write(data)` | `tmux send-keys -t bb-<id> 'data'` |
| Output | `pty.onData(cb)` — push | `tmux pipe-pane -t bb-<id> -o <pipe>` — push |
| Resize | `pty.resize(cols, rows)` | `tmux resize-window -t bb-<id> -x cols -y rows` |
| Kill | `pty.kill()` | `tmux kill-session -t bb-<id>` |
| List | In-memory Map | `tmux list-sessions -F '#{session_name}'` |
| Reattach | N/A | `tmux list-sessions` on startup → reconnect pipe-pane |

### Output Streaming: `pipe-pane` Detail

tmux `pipe-pane` pipes raw PTY output to a command, in real-time:

```bash
# Option A: pipe to FIFO (simple, low latency)
mkfifo /tmp/bb-<id>.fifo
tmux pipe-pane -t bb-<id> -o 'cat > /tmp/bb-<id>.fifo'
# Node.js: fs.createReadStream('/tmp/bb-<id>.fifo')

# Option B: pipe to Unix socket (more robust)
tmux pipe-pane -t bb-<id> -o 'socat - UNIX-CONNECT:/tmp/bb-<id>.sock'
# Node.js: net.createServer() on the socket

# Option C: pipe to file + fs.watch (simplest, slight latency)
tmux pipe-pane -t bb-<id> -o 'cat >> /tmp/bb-<id>.log'
# Node.js: fs.watch() + read new bytes
```

**Recommended: Option A (FIFO)** — lowest latency, no file accumulation, auto-cleans when reader disconnects. Fallback to Option C for robustness.

Latency comparison:
- node-pty `onData`: ~0ms (direct callback)
- tmux `pipe-pane` → FIFO: ~1-2ms (kernel pipe buffer)
- tmux `capture-pane` polling: 50-200ms (need periodic timer)

### Server Restart Recovery

The biggest win of tmux — sessions survive server crashes:

```typescript
// On server startup:
async function recoverSessions(): Promise<void> {
  // Use execFile (not exec) to avoid shell injection
  const { stdout } = await execFileAsync('tmux', [
    'list-sessions', '-F', '#{session_name}'
  ]);
  const tmuxSessions = stdout.trim().split('\n').filter(s => s.startsWith('bb-'));

  for (const name of tmuxSessions) {
    const id = name.slice(3); // strip 'bb-' prefix
    // Re-create pipe-pane output stream
    // Re-initialize state detector from capture-pane snapshot
    // Restore session to in-memory map
  }
}
```

### What Changes, What Stays

| Component | Changes Needed |
|-----------|---------------|
| `session-manager.ts` | **Major rewrite** — replace node-pty with tmux commands |
| `state-detector.ts` | **No change** — still receives text chunks via `feed()` |
| `ws-bridge.ts` | **No change** — still consumes `output` events from SessionManager |
| `api.ts` | **No change** — same REST interface |
| `webhook.ts` | **No change** — still listens to `stateChange` events |
| `transcript.ts` | **No change** — still receives entries from SessionManager |
| `audit-log.ts` | **No change** |
| Dashboard / CLI | **No change** — all frontend code unchanged |

Only `session-manager.ts` needs rewriting. Everything else is insulated by the EventEmitter interface.

### New Dependency

```
tmux >= 3.0 (required)
```

Check: `tmux -V`. macOS: `brew install tmux`. Linux: `apt install tmux`.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `send-keys` escaping issues (special chars) | Use `tmux load-buffer` + `paste-buffer` for binary-safe input |
| FIFO reader disconnect = pipe-pane stops | Watchdog timer to re-establish pipe-pane if stream closes |
| tmux not installed | Check on startup, fall back to node-pty with warning |
| Session naming collisions | Prefix with `bb-` + random ID (same as current) |
| tmux server crash (rare) | Less likely than Node.js crash; tmux is battle-tested C code |
| `pipe-pane` output encoding | Same raw bytes as node-pty; stripAnsi works identically |

### Implementation Phases

**Phase 1: tmux SessionManager (drop-in replacement)**
- New `TmuxSessionManager` implementing same EventEmitter interface
- Spawn via `tmux new-session`
- Output via `pipe-pane` → FIFO → Node.js readable stream
- Input via `tmux send-keys` (with `load-buffer` fallback for special chars)
- Kill via `tmux kill-session`
- All existing tests should pass against new implementation

**Phase 2: Session Recovery**
- On startup, scan `tmux list-sessions` for `bb-*` sessions
- Re-attach pipe-pane streams
- Snapshot current pane content via `tmux capture-pane -p` to bootstrap state detector
- Restore session metadata from persisted file (JSON in `~/.bullybuddy/sessions/`)

**Phase 3: Dual Backend (optional)**
- `BB_BACKEND=tmux|pty` env var to select backend
- Keep node-pty as fallback for environments without tmux
- Feature-flag the recovery logic

---

## Quick Wins (Without tmux Migration)

If the tmux migration is deferred, these changes would improve stability on the current node-pty architecture:

1. **Add `uncaughtException` / `unhandledRejection` handlers** — log and gracefully shutdown instead of silent crash
2. **Fix event listener leak** — clean up task auto-send handler on natural exit (`onExit`), not just on `kill()`
3. **Add WS backpressure** — check `ws.bufferedAmount` before sending; drop output frames if buffer exceeds threshold
4. **Reduce regex cost** — pre-filter: only run full pattern matching if the chunk contains likely trigger characters (❯, ✻, Error, etc.)
5. **Add session health watchdog** — if no output for 5 minutes AND state is `working`, mark as `stale` and optionally notify
6. **Persist session metadata** — write session info to `~/.bullybuddy/sessions/<id>.json` so at least metadata survives a restart (even if the PTY is lost)
