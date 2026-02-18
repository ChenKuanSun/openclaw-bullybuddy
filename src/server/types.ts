// ── Session ──────────────────────────────────────────────────────────────────

export type SessionStatus = 'running' | 'exited';

export type DetailedState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'permission_needed'
  | 'compacting'
  | 'error';

export interface SessionInfo {
  id: string;
  name: string;
  group: string;
  cwd: string;
  status: SessionStatus;
  detailedState: DetailedState;
  exitCode: number | null;
  pid: number | null;
  createdAt: string;
  cols: number;
  rows: number;
  lastActivityAt: string;
  task: string | null;
  taskStartedAt: string | null;
  compactionCount: number;
  totalWorkingMs: number;
  totalIdleMs: number;
  totalPermissionWaitMs: number;
}

export interface SpawnOptions {
  name?: string;
  group?: string;
  cwd?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  task?: string;
  skipPermissions?: boolean;
}

// ── Session Manager Interface ────────────────────────────────────────────────
// Both SessionManager (node-pty) and TmuxSessionManager implement this.

import type { EventEmitter } from 'events';

export interface ISessionManager extends EventEmitter {
  spawn(opts?: SpawnOptions): SessionInfo;
  setTask(id: string, task: string): boolean;
  getInfo(id: string): SessionInfo | undefined;
  getScrollback(id: string): string[];
  getTranscript(id: string): TranscriptEntry[];
  list(group?: string): SessionInfo[];
  groups(): Map<string, SessionInfo[]>;
  write(id: string, data: string): boolean;
  resize(id: string, cols: number, rows: number): boolean;
  kill(id: string): boolean;
  killAll(): void;
  count(): number;
}

// ── REST API ─────────────────────────────────────────────────────────────────

export interface ApiSpawnRequest {
  name?: string;
  group?: string;
  cwd?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  task?: string;
  skipPermissions?: boolean;
}

export interface ApiSetTaskRequest {
  task: string;
}

export interface ApiInputRequest {
  data: string;
}

export interface ApiResizeRequest {
  cols: number;
  rows: number;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface GroupInfo {
  name: string;
  sessionCount: number;
  sessions: SessionInfo[];
}

// ── WebSocket Messages ───────────────────────────────────────────────────────

// Client → Server
export type WsClientMessage =
  | { type: 'subscribe'; sessionId: string; cols?: number; rows?: number }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number };

// Server → Client
export type WsServerMessage =
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'scrollback'; sessionId: string; data: string }
  | { type: 'session:created'; session: SessionInfo }
  | { type: 'session:exited'; sessionId: string; exitCode: number | null }
  | { type: 'session:stateChanged'; sessionId: string; detailedState: DetailedState }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'error'; message: string };

// ── Audit Log ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  action: string;
  sessionId?: string;
  source: 'rest' | 'ws' | 'cli' | 'system';
  actor?: string;
  summary?: string;
  result: 'ok' | 'error';
  error?: string;
}

export interface AuditQueryOptions {
  limit?: number;
  sessionId?: string;
  action?: string;
}

// ── Conversation Transcript ───────────────────────────────────────────────────

export interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
}
