# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-02-18

### Added

- **Tmux session backend**: Sessions survive server restarts via tmux (default, auto-detected); falls back to node-pty
- **Session recovery**: Existing tmux sessions are recovered on server restart with metadata and pipe-pane reattach
- **Shared config module**: Extracted constants and utilities (`ALLOWED_FLAGS`, `isAllowedArg`, `sanitizeColsRows`) to `shared.ts`
- **Comprehensive test suite**: 167 tests (up from 98) — tmux manager, webhook, shared utils, rate limiter

### Fixed

- **Security: BB_TOKEN leak** — `makeEnvArgs()` now wired into tmux `new-session` to strip sensitive env vars
- **Security: File permissions** — All files/dirs under `~/.bullybuddy/` hardened to `0o700`/`0o600` (owner-only)
- **Tmp file cleanup** — Input buffer files cleaned in `finally` block even on tmux errors
- **Exit code accuracy** — Tmux sessions report `null` exit code (tmux limitation) instead of misleading `0`
- **Webhook error logging** — POST failures logged via `console.warn` instead of silently swallowed
- **WebSocket send safety** — `ws.send()` wrapped in try/catch for mid-send disconnects
- **pollExits robustness** — Distinguishes tmux exit code 1 (normal) from unexpected errors with logging
- **Rate limiter cleanup** — Periodic pruning of stale IP entries (every 5 minutes)

### Changed

- Both `SessionManager` and `TmuxSessionManager` now declare `implements ISessionManager`
- `DetailedState` type canonical definition in `types.ts`; re-exported from `state-detector.ts`
- Removed unused `isMuted` import from `api.ts`, unused `SessionStatus` import from `session-manager.ts`
- Updated README and SKILL.md to document dual backend architecture, all env vars

## [0.1.0] - 2026-02-11

### Added

- Initial release
- **Session management**: Spawn, kill, and monitor Claude Code instances via `node-pty`
- **State detection**: Real-time analysis of PTY output (working, idle, permission_needed, compacting, error, exited)
- **Web dashboard**: Real-time terminal view with session sidebar, groups, and settings
- **3D lobster view**: Three.js scene with animated lobster workers
- **CLI** (`bullybuddy`): Full terminal interface for automation
- **REST API**: Complete session management endpoints
- **WebSocket**: Real-time streaming of PTY output and state changes
- **Webhook notifications**: POST to external URLs on state changes
- **Auth tokens**: Required for all API/WS access
- **Task tracking**: `task`, `taskStartedAt`, time metrics (`totalWorkingMs`, `totalIdleMs`, `totalPermissionWaitMs`)
- **Audit log**: In-memory ring buffer with optional JSONL persistence
- **Conversation transcript**: Per-session transcript with user/assistant messages
- **Session groups**: Organize sessions by project
- **Mute/unmute**: Per-session webhook muting
- **Summary API**: `/api/summary` with state counts and `sessionsNeedingAttention`
- **OpenClaw integration**: SKILL.md for ClawHub, `/bb` slash command skill

### Security

- Path traversal protection on `/api/browse`
- Rate limiting on spawn (10/60s per IP)
- Content-Type validation on JSON endpoints
- Token required for dashboard HTML access
