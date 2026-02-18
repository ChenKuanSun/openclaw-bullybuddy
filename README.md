# OpenClaw BullyBuddy

[![npm version](https://img.shields.io/npm/v/openclaw-bullybuddy.svg)](https://www.npmjs.com/package/openclaw-bullybuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

![BullyBuddy 3D Lobster Farm](cover.png)

Claude Code session manager with web dashboard and CLI. Spawn, group, and monitor multiple Claude Code instances. Dual backend: **tmux** (default, sessions survive server restart) or **node-pty** (fallback).

## Features

- **Session management** — spawn, kill, and monitor Claude Code instances via tmux (default) or node-pty
- **Smart state detection** — real-time analysis of PTY output to detect working, idle, permission_needed, compacting, error states
- **Web dashboard** — real-time terminal view with session sidebar, groups, and settings
- **3D lobster view** — Three.js scene with animated lobster workers grouped by project
- **CLI** (`bullybuddy`) — full terminal interface for scripting and automation
- **Session groups** — organize sessions by project or purpose
- **Webhook notifications** — POST to external URLs (e.g., OpenClaw) on state changes
- **Auth tokens** — random token generated on each server start; required for all API/WS access

## Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on `PATH`
- [tmux](https://github.com/tmux/tmux) (recommended — sessions survive server restart; falls back to node-pty if unavailable)

## Install

```bash
npm install -g openclaw-bullybuddy
```

Or clone and develop locally:

```bash
git clone https://github.com/ChenKuanSun/openclaw-bullybuddy.git
cd openclaw-bullybuddy
npm install
npm run dev
```

## Architecture

- **Server**: Native Node.js `http` + `ws` (no framework)
- **Dashboard**: Vanilla TypeScript + xterm.js + Three.js, built with Vite
- **CLI**: `commander` for command parsing
- **Session backend** (dual):
  - **tmux** (default) — sessions survive server restart, output via `pipe-pane`, input via `load-buffer`/`paste-buffer`
  - **node-pty** (fallback) — sessions tied to server lifetime, direct PTY I/O
- **State detector**: Analyzes PTY output patterns to determine Claude's actual state

## Usage

### Start the server

```bash
bullybuddy server
```

The server prints a dashboard URL with an auth token:

```
[bb] server listening on http://127.0.0.1:18900
[bb] token:     a1b2c3d4...
[bb] dashboard: http://127.0.0.1:18900/?token=a1b2c3d4...
```

Start with `--tunnel` to create a Cloudflare temporary URL for remote/mobile access:

```bash
bullybuddy server --tunnel
```

### CLI commands

```bash
# Spawn a session
bullybuddy spawn --name "feature-work" --group myproject --cwd ~/Project/myapp

# Spawn with claude flags (allowlisted flags pass through)
bullybuddy spawn -- --dangerously-skip-permissions --model sonnet

# List sessions (includes detailedState)
bullybuddy list
bullybuddy list --group myproject --json

# Send input to a session
bullybuddy send <session-id> "fix the login bug"

# Attach to a session (interactive, Ctrl+] to detach)
bullybuddy attach <session-id>

# Kill a session
bullybuddy kill <session-id>

# List groups
bullybuddy groups

# Show dashboard URL (local + tunnel)
bullybuddy url

# Open dashboard in browser
bullybuddy open
```

### Smart state detection

Each session has a `detailedState` field updated in real-time by analyzing PTY output:

| State | Meaning | Dashboard indicator |
|-------|---------|-------------------|
| `starting` | Claude is loading | pulsing grey dot |
| `working` | Thinking/writing/editing (spinner visible) | pulsing green dot |
| `permission_needed` | Waiting for user approval | pulsing orange dot |
| `idle` | At prompt, ready for input | blue dot |
| `compacting` | Compacting conversation history | purple dot |
| `error` | An error occurred | red dot |

State changes are broadcast via WebSocket (`session:stateChanged` message) and reflected on the dashboard sidebar and 3D lobster animations.

### Webhook notifications

Set `BB_OPENCLAW_WEBHOOK_URL` to receive POST notifications for notable events:

```bash
BB_OPENCLAW_WEBHOOK_URL=http://localhost:3000/webhook bullybuddy server
```

Events fired: `state:permission_needed`, `state:error`, `state:long_idle`, `session:exited`.

Per-session mute: `POST /api/sessions/:id/mute` and `/unmute`.

### Claude CLI flags

Spawned sessions accept an allowlist of claude CLI flags:

| Flag | Description |
|------|-------------|
| `--model`, `-m` | Model selection |
| `--print`, `-p` | Non-interactive mode |
| `--resume`, `-r` | Resume session |
| `--continue`, `-c` | Continue conversation |
| `--dangerously-skip-permissions` | Auto-accept (full power) |
| `--verbose` | Verbose output |
| `--version` | Show version |

To allow additional flags, set `BB_EXTRA_ARGS` (comma-separated):

```bash
BB_EXTRA_ARGS="--output-format,--max-turns" bullybuddy server
```

### Authentication

All API and WebSocket endpoints require a token. The token is auto-generated on server start and saved to `~/.bullybuddy/connection.json`.

- **CLI / `/bullybuddy` slash command**: Auto-discovers token from `~/.bullybuddy/connection.json` — no configuration needed
- **Dashboard**: Pass `?token=...` in the URL (automatically persisted in sessionStorage)
- **API**: Use `Authorization: Bearer <token>` header or `?token=...` query parameter

The connection file is cleaned up on graceful shutdown.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BB_PORT` | `18900` | Server port |
| `BB_HOST` | `127.0.0.1` | Server bind address (use `0.0.0.0` for remote/mobile access) |
| `BB_TOKEN` | (auto-generated) | Auth token (saved to `~/.bullybuddy/connection.json`) |
| `BB_BACKEND` | `auto` | Session backend: `tmux`, `pty`, or `auto` (prefers tmux when available) |
| `BB_SKIP_PERMISSIONS` | `false` | Set `true` to auto-add `--dangerously-skip-permissions` to spawned sessions |
| `BB_ENABLE_BROWSE` | `false` | Set `true` to enable the `/api/browse` directory browser endpoint |
| `BB_EXTRA_ARGS` | (none) | Additional allowed claude CLI flags (comma-separated) |
| `BB_OPENCLAW_WEBHOOK_URL` | (none) | Webhook URL for state notifications (metadata only, no terminal output) |
| `BB_TRANSCRIPT_DIR` | (none) | Directory to persist conversation transcripts as `.jsonl` files |
| `BB_TRANSCRIPT_SIZE` | `500` | Max transcript entries kept in memory per session |
| `BB_AUDIT_LOG_FILE` | (none) | File path to persist audit log entries (JSONL) |
| `BB_AUDIT_LOG_SIZE` | `1000` | Max audit entries kept in memory |

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server status |
| `GET` | `/api/sessions` | List sessions (filter: `?group=`) |
| `POST` | `/api/sessions` | Spawn session `{ name, group, cwd, args[] }` |
| `GET` | `/api/sessions/:id` | Session detail (includes `detailedState`) |
| `POST` | `/api/sessions/:id/input` | Send input `{ data }` |
| `POST` | `/api/sessions/:id/resize` | Resize PTY `{ cols, rows }` |
| `DELETE` | `/api/sessions/:id` | Kill session |
| `POST` | `/api/sessions/:id/mute` | Mute webhook notifications |
| `POST` | `/api/sessions/:id/unmute` | Unmute webhook notifications |
| `POST` | `/api/sessions/:id/task` | Set task metadata `{ task }` |
| `GET` | `/api/groups` | List groups with session counts |
| `GET` | `/api/summary` | Aggregate state counts and groups |
| `GET` | `/api/browse` | Browse directories `?path=` (requires `BB_ENABLE_BROWSE=true`) |
| `GET` | `/api/audit` | Audit log |
| `GET` | `/api/sessions/:id/transcript` | Conversation transcript |

## Development

```bash
npm run dev          # Start server + Vite dev server (with HMR)
npm run build        # Build for production
npm run typecheck    # Type-check server code
npm test             # Run tests
npm start            # Run production build
```

## License

[MIT](LICENSE)
