---
name: bullybuddy
description: >
  Claude Code session manager using node-pty. Spawn multiple Claude Code CLI
  instances, run parallel coding tasks across repos, monitor session states
  in real-time, view sessions via web dashboard with 3D lobster visualization,
  and orchestrate multi-agent coding workflows.
metadata:
  {
    "openclaw":
      {
        "emoji": "🦞",
        "requires": { "bins": ["bullybuddy", "claude"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "openclaw-bullybuddy",
              "bins": ["bullybuddy"],
            },
          ],
      },
  }
---

# BullyBuddy

Spawns and manages multiple Claude Code CLI sessions via `node-pty`. REST API, WebSocket streaming, web dashboard — no tmux needed.

## Server Setup

1. Install the package globally:

```bash
npm install -g openclaw-bullybuddy
```

2. Start the server:

```bash
bullybuddy server
```

Connection info is auto-saved to `~/.bullybuddy/connection.json` on startup. The `/bb` slash command reads it automatically — no env vars needed.

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
| `GET` | `/api/browse` | Browse directories (disabled by default) |
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

Webhooks are also supported via `BB_OPENCLAW_WEBHOOK_URL` for push-based state notifications (metadata only, no terminal output).

## Remote Access

Start the server with `--tunnel` to create a Cloudflare temporary URL automatically:

```bash
bullybuddy server --tunnel
```

The tunnel URL is printed on startup and saved to `~/.bullybuddy/connection.json`. Use `bullybuddy url` or `/bb url` to retrieve it anytime.

For LAN-only access, bind to all interfaces instead:

```bash
BB_HOST=0.0.0.0 bullybuddy server
```

## Configuration

Default server binds to `127.0.0.1:18900`. See the project README for advanced configuration options (`BB_PORT`, `BB_HOST`, etc.).

## CLI Commands

```bash
bullybuddy server                          # Start server
bullybuddy server --tunnel                 # Start with Cloudflare tunnel
bullybuddy url                             # Show dashboard URL (local + tunnel)
bullybuddy spawn --name worker --group proj  # Spawn session
bullybuddy list --json                     # List sessions
bullybuddy send <id> "Fix the bug"         # Send input
bullybuddy attach <id>                     # Interactive terminal
bullybuddy kill <id>                       # Kill session
bullybuddy groups                          # List groups
bullybuddy open                            # Open dashboard
```
