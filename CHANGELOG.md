# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
