// Webhook notifier: sends state change events to an external URL (e.g., OpenClaw).
//
// Configure via BB_OPENCLAW_WEBHOOK_URL env var.
// Only fires for notable events: permission_needed, error, exit, long idle.

import type { SessionManager } from './session-manager.js';
import type { DetailedState, SessionInfo } from './types.js';

const WEBHOOK_URL = process.env.BB_OPENCLAW_WEBHOOK_URL ?? '';
const IDLE_ALERT_MS = 60_000; // Alert after 60s idle following activity

interface WebhookPayload {
  event: string;
  sessionId: string;
  sessionName: string;
  group: string;
  state: DetailedState | 'exited';
  recentOutput?: string;
  exitCode?: number | null;
  timestamp: string;
  task?: string | null;
  totalWorkingMs?: number;
  compactionCount?: number;
  idleSinceMs?: number;
}

// Sessions with muted notifications
const mutedSessions = new Set<string>();

// Track sessions that were recently active (to detect idle-after-work)
const wasActive = new Set<string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

import { stripAnsi } from './utils.js';

function getRecentOutput(scrollback: string[], lines: number = 5): string {
  const joined = stripAnsi(scrollback.slice(-20).join(''));
  const allLines = joined.split('\n').filter((l) => l.trim().length > 0);
  return allLines.slice(-lines).join('\n');
}

async function postWebhook(payload: WebhookPayload): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silently ignore webhook failures — don't break session management
  }
}

export function muteSession(sessionId: string): void {
  mutedSessions.add(sessionId);
}

export function unmuteSession(sessionId: string): void {
  mutedSessions.delete(sessionId);
}

export function isMuted(sessionId: string): boolean {
  return mutedSessions.has(sessionId);
}

export function setupWebhook(sessions: SessionManager): void {
  if (!WEBHOOK_URL) return;

  console.log(`[bb] webhook: ${WEBHOOK_URL}`);

  sessions.on('stateChange', (sessionId: string, state: DetailedState, _prev: DetailedState) => {
    if (mutedSessions.has(sessionId)) return;

    const info = sessions.getInfo(sessionId);
    if (!info) return;

    // Clear any pending idle timer
    const existing = idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      idleTimers.delete(sessionId);
    }

    if (state === 'working') {
      wasActive.add(sessionId);
    }

    // Fire webhook for notable states
    if (state === 'permission_needed' || state === 'error') {
      const scrollback = sessions.getScrollback(sessionId);
      // Re-fetch info to get live metrics
      const freshInfo = sessions.getInfo(sessionId);
      postWebhook({
        event: `state:${state}`,
        sessionId,
        sessionName: info.name,
        group: info.group,
        state,
        recentOutput: getRecentOutput(scrollback),
        timestamp: new Date().toISOString(),
        task: freshInfo?.task,
        totalWorkingMs: freshInfo?.totalWorkingMs,
        compactionCount: freshInfo?.compactionCount,
      });
    }

    // Set up idle-after-activity alert
    if (state === 'idle' && wasActive.has(sessionId)) {
      wasActive.delete(sessionId);
      const timer = setTimeout(() => {
        idleTimers.delete(sessionId);
        if (mutedSessions.has(sessionId)) return;
        const currentInfo = sessions.getInfo(sessionId);
        if (!currentInfo || currentInfo.status !== 'running') return;

        const idleSinceMs = Date.now() - new Date(currentInfo.lastActivityAt).getTime();
        postWebhook({
          event: 'state:long_idle',
          sessionId,
          sessionName: currentInfo.name,
          group: currentInfo.group,
          state: 'idle',
          timestamp: new Date().toISOString(),
          task: currentInfo.task,
          totalWorkingMs: currentInfo.totalWorkingMs,
          compactionCount: currentInfo.compactionCount,
          idleSinceMs,
        });
      }, IDLE_ALERT_MS);
      idleTimers.set(sessionId, timer);
    }
  });

  sessions.on('exit', (sessionId: string, exitCode: number | null) => {
    // Clean up timers
    wasActive.delete(sessionId);
    const t = idleTimers.get(sessionId);
    if (t) { clearTimeout(t); idleTimers.delete(sessionId); }
    mutedSessions.delete(sessionId);

    // getInfo works here because the 'exit' event fires before kill() removes the session
    const info = sessions.getInfo(sessionId);
    if (!info) return;

    postWebhook({
      event: 'session:exited',
      sessionId,
      sessionName: info.name,
      group: info.group,
      state: 'exited',
      exitCode,
      timestamp: new Date().toISOString(),
      task: info.task,
      totalWorkingMs: info.totalWorkingMs,
      compactionCount: info.compactionCount,
    });
  });
}
