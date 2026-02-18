import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { SessionInfo } from '../src/server/types.js';

// Must set env BEFORE importing webhook module (WEBHOOK_URL is evaluated at import time)
vi.hoisted(() => {
  process.env.BB_OPENCLAW_WEBHOOK_URL = 'http://test-webhook.local/hook';
});

// Mock global fetch
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', mockFetch);

import { setupWebhook, muteSession, unmuteSession, isMuted } from '../src/server/webhook.js';

function makeSessionInfo(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    name: 'test',
    group: 'default',
    cwd: '/tmp',
    status: 'running',
    detailedState: 'idle',
    exitCode: null,
    pid: 12345,
    createdAt: new Date().toISOString(),
    cols: 120,
    rows: 40,
    lastActivityAt: new Date().toISOString(),
    task: null,
    taskStartedAt: null,
    compactionCount: 0,
    totalWorkingMs: 0,
    totalIdleMs: 0,
    totalPermissionWaitMs: 0,
    ...overrides,
  };
}

class MockSessions extends EventEmitter {
  private infos = new Map<string, SessionInfo>();

  addSession(info: SessionInfo): void {
    this.infos.set(info.id, info);
  }

  getInfo(id: string): SessionInfo | undefined {
    return this.infos.get(id);
  }
}

describe('Webhook', () => {
  let sessions: MockSessions;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockClear();
    sessions = new MockSessions();
    setupWebhook(sessions as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    sessions.removeAllListeners();
  });

  it('fires webhook on permission_needed state', async () => {
    const info = makeSessionInfo({ id: 's1', name: 'worker-1' });
    sessions.addSession(info);

    sessions.emit('stateChange', 's1', 'permission_needed', 'working');

    await vi.advanceTimersByTimeAsync(0); // flush microtask queue
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test-webhook.local/hook');
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('state:permission_needed');
    expect(body.sessionId).toBe('s1');
    expect(body.sessionName).toBe('worker-1');
  });

  it('fires webhook on error state', async () => {
    const info = makeSessionInfo({ id: 's2' });
    sessions.addSession(info);

    sessions.emit('stateChange', 's2', 'error', 'working');

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('state:error');
  });

  it('does not fire webhook on working or idle state', () => {
    const info = makeSessionInfo({ id: 's3' });
    sessions.addSession(info);

    sessions.emit('stateChange', 's3', 'working', 'starting');
    sessions.emit('stateChange', 's3', 'idle', 'working');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires long_idle webhook after 60s of idle following activity', async () => {
    const info = makeSessionInfo({ id: 's4' });
    sessions.addSession(info);

    // Mark as active first
    sessions.emit('stateChange', 's4', 'working', 'idle');
    expect(mockFetch).not.toHaveBeenCalled();

    // Transition to idle
    sessions.emit('stateChange', 's4', 'idle', 'working');

    // Not yet — 60s hasn't passed
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockFetch).not.toHaveBeenCalled();

    // Now at 60s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('state:long_idle');
  });

  it('cancels long_idle timer on new activity', async () => {
    const info = makeSessionInfo({ id: 's5' });
    sessions.addSession(info);

    sessions.emit('stateChange', 's5', 'working', 'idle');
    sessions.emit('stateChange', 's5', 'idle', 'working');

    // Start working again before 60s
    await vi.advanceTimersByTimeAsync(30_000);
    sessions.emit('stateChange', 's5', 'working', 'idle');

    // Wait past the original 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires webhook on session exit', async () => {
    const info = makeSessionInfo({ id: 's6', name: 'exiting' });
    sessions.addSession(info);

    sessions.emit('exit', 's6', 0);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('session:exited');
    expect(body.exitCode).toBe(0);
  });

  it('does not fire webhook for muted sessions', () => {
    const info = makeSessionInfo({ id: 's7' });
    sessions.addSession(info);

    muteSession('s7');
    sessions.emit('stateChange', 's7', 'permission_needed', 'working');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fires webhook again after unmuting', async () => {
    const info = makeSessionInfo({ id: 's8' });
    sessions.addSession(info);

    muteSession('s8');
    sessions.emit('stateChange', 's8', 'permission_needed', 'working');
    expect(mockFetch).not.toHaveBeenCalled();

    unmuteSession('s8');
    sessions.emit('stateChange', 's8', 'error', 'permission_needed');

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('logs warning on fetch failure', async () => {
    const info = makeSessionInfo({ id: 's9' });
    sessions.addSession(info);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    sessions.emit('stateChange', 's9', 'permission_needed', 'working');

    await vi.advanceTimersByTimeAsync(0);
    // Allow the promise rejection to propagate
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('webhook POST failed'));
    warnSpy.mockRestore();
  });

  it('includes task in webhook payload', async () => {
    const info = makeSessionInfo({ id: 's10', task: 'fix the bug' });
    sessions.addSession(info);

    sessions.emit('stateChange', 's10', 'permission_needed', 'working');

    await vi.advanceTimersByTimeAsync(0);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.task).toBe('fix the bug');
  });

  it('cleans up idle timer on exit', async () => {
    const info = makeSessionInfo({ id: 's11' });
    sessions.addSession(info);

    // Set up idle timer
    sessions.emit('stateChange', 's11', 'working', 'idle');
    sessions.emit('stateChange', 's11', 'idle', 'working');

    // Exit before idle timer fires
    sessions.emit('exit', 's11', 0);

    await vi.advanceTimersByTimeAsync(0);
    // Only exit webhook, not long_idle
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('session:exited');

    // Ensure idle timer doesn't fire later
    mockFetch.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('muteSession / unmuteSession / isMuted', () => {
  it('tracks mute state', () => {
    expect(isMuted('x')).toBe(false);
    muteSession('x');
    expect(isMuted('x')).toBe(true);
    unmuteSession('x');
    expect(isMuted('x')).toBe(false);
  });
});
