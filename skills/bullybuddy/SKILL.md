---
name: bullybuddy
description: >
  Claude Code session manager using node-pty. Spawn multiple Claude Code CLI
  instances, run parallel coding tasks across repos, monitor session states
  in real-time, view sessions via web dashboard with 3D lobster visualization,
  and orchestrate multi-agent coding workflows.
metadata:
  openclaw:
    emoji: "🦞"
    requires:
      bins: ["bullybuddy", "claude"]
    install:
      - id: node
        kind: node
        package: openclaw-bullybuddy
        bins: ["bullybuddy"]
        label: "Install BullyBuddy (npm)"
---

# BullyBuddy

Spawns and manages multiple Claude Code CLI sessions via `node-pty`. REST API, WebSocket streaming, web dashboard — no tmux needed.

## Server Setup

1. Install the package globally:

```bash
npm install -g openclaw-bullybuddy
```

2. Start the server (it prints an auth token and dashboard URL on startup):

```bash
bullybuddy server
```

3. Configure your OpenClaw environment with the server URL and the token printed above:

```json
{
  "env": {
    "BB_URL": "http://127.0.0.1:18900",
    "BB_TOKEN": "<token from step 2>"
  }
}
```

## Quick Start

```bash
# Spawn a session with a task
bullybuddy spawn --name fix-auth --group myproject --cwd ~/app

# List sessions
bullybuddy list

# Send input to a session
bullybuddy send <id> "Fix the login bug in auth.ts"

# Attach to a session interactively
bullybuddy attach <id>

# Open web dashboard
bullybuddy open
```

## API Overview

All endpoints require authentication via header or query parameter. All responses follow `{ ok: boolean, data?: T, error?: string }`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server status |
| `GET` | `/api/sessions` | List sessions (filter by group) |
| `POST` | `/api/sessions` | Spawn session |
| `GET` | `/api/sessions/:id` | Session detail with metrics |
| `DELETE` | `/api/sessions/:id` | Kill session |
| `POST` | `/api/sessions/:id/input` | Send input to PTY |
| `POST` | `/api/sessions/:id/resize` | Resize PTY |
| `POST` | `/api/sessions/:id/task` | Set task metadata |
| `POST` | `/api/sessions/:id/mute` | Mute notifications |
| `POST` | `/api/sessions/:id/unmute` | Unmute notifications |
| `GET` | `/api/groups` | Groups with session counts |
| `GET` | `/api/summary` | Aggregate state counts and groups |
| `GET` | `/api/browse` | Browse directories (restricted to $HOME) |
| `GET` | `/api/audit` | Audit log |
| `GET` | `/api/sessions/:id/transcript` | Conversation transcript |

### Spawn Request Body

```json
{
  "name": "worker-1",
  "group": "myproject",
  "cwd": "/path/to/repo",
  "task": "Implement feature X",
  "args": ["--verbose"],
  "cols": 120,
  "rows": 40
}
```

All fields optional. When `task` is provided, it is automatically sent as input when Claude reaches the idle prompt.

**Note:** When sending input, terminate with `\r` (carriage return), not `\n`.

## WebSocket Protocol

Connect to `ws://<host>:<port>/ws` with auth credentials.

### Client Messages

| type | fields | description |
|------|--------|-------------|
| `subscribe` | `sessionId`, `cols?`, `rows?` | Receive output from session |
| `unsubscribe` | `sessionId` | Stop receiving output |
| `input` | `sessionId`, `data` | Send keystrokes to PTY |
| `resize` | `sessionId`, `cols`, `rows` | Resize PTY |

### Server Messages

| type | fields | description |
|------|--------|-------------|
| `sessions` | `sessions[]` | Full session list (on connect) |
| `output` | `sessionId`, `data` | Terminal output chunk |
| `scrollback` | `sessionId`, `data` | Buffered scrollback on subscribe |
| `session:created` | `session` | New session spawned |
| `session:exited` | `sessionId`, `exitCode` | Session terminated |
| `session:stateChanged` | `sessionId`, `detailedState` | State transition |

## State Detection

BullyBuddy analyzes raw PTY output to detect Claude Code's state in real-time.

| `detailedState` | Meaning |
|-----------------|---------|
| `starting` | Session just spawned, Claude loading |
| `working` | Claude is thinking/editing (spinner visible) |
| `permission_needed` | Claude waiting for user approval |
| `idle` | Claude at prompt, ready for input |
| `compacting` | Compacting conversation history |
| `error` | Error detected in output |

State transitions are broadcast via WebSocket and reflected in `GET /api/summary`.

## OpenClaw Integration

Poll `GET /api/summary` on an interval to check fleet status. The `sessionsNeedingAttention` field contains IDs of sessions in `permission_needed` or `error` state.

Webhooks are also supported via `BB_OPENCLAW_WEBHOOK_URL` for push-based notifications on state changes.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BB_PORT` | `18900` | Server port |
| `BB_HOST` | `127.0.0.1` | Bind address |
| `BB_TOKEN` | auto-generated | Auth token (printed on startup) |
| `BB_EXTRA_ARGS` | — | Additional allowed Claude CLI flags, comma-separated |
| `BB_OPENCLAW_WEBHOOK_URL` | — | Webhook URL for push-based state notifications |
| `BB_AUDIT_LOG_SIZE` | `1000` | Max audit log entries |
| `BB_AUDIT_LOG_FILE` | — | Path to persistent JSONL audit log |
| `BB_TRANSCRIPT_SIZE` | `500` | Max transcript entries per session |
| `BB_TRANSCRIPT_DIR` | — | Directory for per-session JSONL transcript files |

## CLI Commands

```bash
bullybuddy server                          # Start server
bullybuddy spawn --name worker --group proj  # Spawn session
bullybuddy list --json                     # List sessions
bullybuddy send <id> "Fix the bug"         # Send input
bullybuddy attach <id>                     # Interactive terminal
bullybuddy kill <id>                       # Kill session
bullybuddy groups                          # List groups
bullybuddy open                            # Open dashboard
```
