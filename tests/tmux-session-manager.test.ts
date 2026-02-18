import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before any imports
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

// Mock fs to avoid real file I/O
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{}'),
  unlinkSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  readSync: vi.fn(() => 0),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true, size: 0 })),
  appendFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { TmuxSessionManager, isTmuxAvailable } from '../src/server/tmux-session-manager.js';

const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockStatSync = vi.mocked(statSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function setupTmuxMock(overrides: Record<string, string | (() => string)> = {}) {
  mockExec.mockImplementation((_cmd: any, args: any) => {
    const subCmd = (args as string[])?.[0];
    if (subCmd && subCmd in overrides) {
      const val = overrides[subCmd];
      return (typeof val === 'function' ? val() : val) as any;
    }
    switch (subCmd) {
      case 'new-session': return '' as any;
      case 'pipe-pane': return '' as any;
      case 'list-panes': return '12345' as any;
      case 'list-sessions': return '' as any;
      case 'kill-session': return '' as any;
      case 'resize-window': return '' as any;
      case 'load-buffer': return '' as any;
      case 'paste-buffer': return '' as any;
      case 'capture-pane': return '' as any;
      case 'display-message': return '/tmp' as any;
      case '-V': return 'tmux 3.4' as any;
      default: return '' as any;
    }
  });
}

describe('TmuxSessionManager', () => {
  let sm: TmuxSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setupTmuxMock();

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true, size: 0 } as any);

    sm = new TmuxSessionManager();
  });

  afterEach(() => {
    sm.killAll();
    vi.useRealTimers();
  });

  // ── Spawn ─────────────────────────────────────────────────────────────────

  it('spawns a session with auto-generated name and id', () => {
    const info = sm.spawn();
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    expect(info.name).toBe('Claude');
    expect(info.group).toBe('default');
    expect(info.status).toBe('running');
    expect(info.detailedState).toBe('starting');
    expect(info.pid).toBe(12345);
  });

  it('auto-names sessions sequentially', () => {
    const a = sm.spawn();
    const b = sm.spawn();
    const c = sm.spawn();
    expect(a.name).toBe('Claude');
    expect(b.name).toBe('Claude 2');
    expect(c.name).toBe('Claude 3');
  });

  it('respects custom name, group, and cwd', () => {
    const info = sm.spawn({ name: 'worker', group: 'mygroup', cwd: '/tmp' });
    expect(info.name).toBe('worker');
    expect(info.group).toBe('mygroup');
    expect(info.cwd).toBe('/tmp');
  });

  it('calls tmux new-session with correct args', () => {
    sm.spawn({ cwd: '/tmp' });
    const newSessionCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'new-session',
    );
    expect(newSessionCall).toBeTruthy();
    const args = newSessionCall![1] as string[];
    expect(args).toContain('-d');
    expect(args).toContain('-c');
    expect(args).toContain('/tmp');
    // Should include env-unsetting args for BB_TOKEN
    expect(args).toContain('-e');
    const eIdx = args.indexOf('-e');
    expect(args[eIdx + 1]).toContain('BB_TOKEN=');
  });

  it('calls pipe-pane to set up output streaming', () => {
    sm.spawn();
    const pipePaneCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'pipe-pane',
    );
    expect(pipePaneCall).toBeTruthy();
  });

  it('emits created event on spawn', () => {
    const handler = vi.fn();
    sm.on('created', handler);
    const info = sm.spawn();
    expect(handler).toHaveBeenCalledWith(info);
    sm.off('created', handler);
  });

  it('throws on invalid cwd', () => {
    mockExistsSync.mockReturnValueOnce(false);
    expect(() => sm.spawn({ cwd: '/nonexistent' })).toThrow('Invalid working directory');
  });

  it('throws on unknown CLI args', () => {
    expect(() => sm.spawn({ args: ['--unknown-flag'] })).toThrow('Unknown argument');
  });

  it('allows known CLI args', () => {
    expect(() => sm.spawn({ args: ['--verbose', '--model', 'sonnet'] })).not.toThrow();
  });

  it('adds --dangerously-skip-permissions when skipPermissions is true', () => {
    sm.spawn({ skipPermissions: true });
    const newSessionCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'new-session',
    );
    const cmdArg = (newSessionCall![1] as string[]).at(-1)!;
    expect(cmdArg).toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions by default', () => {
    sm.spawn();
    const newSessionCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'new-session',
    );
    const cmdArg = (newSessionCall![1] as string[]).at(-1)!;
    expect(cmdArg).not.toContain('--dangerously-skip-permissions');
  });

  it('stores task on spawn', () => {
    const info = sm.spawn({ task: 'fix the login bug' });
    expect(info.task).toBe('fix the login bug');
    expect(info.taskStartedAt).toBeTruthy();
  });

  it('persists session metadata on spawn', () => {
    sm.spawn();
    const metaWriteCalls = mockWriteFileSync.mock.calls.filter(
      (c) => (c[0] as string).includes('sessions/'),
    );
    expect(metaWriteCalls.length).toBeGreaterThanOrEqual(1);
    // Check that mode 0o600 is used
    const opts = metaWriteCalls[0][2] as any;
    expect(opts?.mode).toBe(0o600);
  });

  // ── List / Groups / Count ─────────────────────────────────────────────────

  it('lists sessions, optionally filtered by group', () => {
    sm.spawn({ group: 'a' });
    sm.spawn({ group: 'b' });
    sm.spawn({ group: 'a' });
    expect(sm.list()).toHaveLength(3);
    expect(sm.list('a')).toHaveLength(2);
    expect(sm.list('b')).toHaveLength(1);
  });

  it('returns groups map', () => {
    sm.spawn({ group: 'x' });
    sm.spawn({ group: 'y' });
    sm.spawn({ group: 'x' });
    const groups = sm.groups();
    expect(groups.get('x')).toHaveLength(2);
    expect(groups.get('y')).toHaveLength(1);
  });

  it('returns session count', () => {
    expect(sm.count()).toBe(0);
    sm.spawn();
    sm.spawn();
    expect(sm.count()).toBe(2);
  });

  // ── Write ─────────────────────────────────────────────────────────────────

  it('sends input via tmux load-buffer and paste-buffer', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    setupTmuxMock();

    expect(sm.write(info.id, 'hello\r')).toBe(true);

    const loadCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'load-buffer',
    );
    const pasteCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'paste-buffer',
    );
    expect(loadCall).toBeTruthy();
    expect(pasteCall).toBeTruthy();
  });

  it('cleans up tmp buffer file after write', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    setupTmuxMock();

    sm.write(info.id, 'data\r');

    // unlinkSync should have been called for the tmp file
    const unlinkCalls = mockUnlinkSync.mock.calls.filter(
      (c) => (c[0] as string).includes('input-'),
    );
    expect(unlinkCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('cleans up tmp buffer file even on tmux error', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    mockExec.mockImplementation((_cmd: any, args: any) => {
      const subCmd = (args as string[])?.[0];
      if (subCmd === 'load-buffer') throw new Error('tmux error');
      return '' as any;
    });

    expect(sm.write(info.id, 'data\r')).toBe(false);

    // unlinkSync should still be called (finally block)
    const unlinkCalls = mockUnlinkSync.mock.calls.filter(
      (c) => (c[0] as string).includes('input-'),
    );
    expect(unlinkCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('write returns false for nonexistent session', () => {
    expect(sm.write('nonexistent', 'data')).toBe(false);
  });

  it('write returns false for exited session', () => {
    const info = sm.spawn();
    // Force session to exited state via pollExits
    setupTmuxMock({ 'list-sessions': '' }); // no sessions in tmux
    vi.advanceTimersByTime(2000); // trigger pollExits
    expect(sm.write(info.id, 'data')).toBe(false);
  });

  // ── Resize ────────────────────────────────────────────────────────────────

  it('resizes tmux window', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    setupTmuxMock();

    expect(sm.resize(info.id, 200, 50)).toBe(true);

    const resizeCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'resize-window',
    );
    expect(resizeCall).toBeTruthy();
    const args = resizeCall![1] as string[];
    expect(args).toContain('200');
    expect(args).toContain('50');

    const updated = sm.getInfo(info.id)!;
    expect(updated.cols).toBe(200);
    expect(updated.rows).toBe(50);
  });

  it('resize returns false on tmux error', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    mockExec.mockImplementation(() => { throw new Error('resize failed'); });
    expect(sm.resize(info.id, 200, 50)).toBe(false);
  });

  it('resize returns false for nonexistent session', () => {
    expect(sm.resize('nonexistent', 80, 24)).toBe(false);
  });

  // ── Kill ──────────────────────────────────────────────────────────────────

  it('kills a tmux session and emits exit event', () => {
    const info = sm.spawn();
    const handler = vi.fn();
    sm.on('exit', handler);

    expect(sm.kill(info.id)).toBe(true);

    // Verify tmux kill-session was called
    const killCall = mockExec.mock.calls.find(
      (c) => (c[1] as string[])?.[0] === 'kill-session',
    );
    expect(killCall).toBeTruthy();

    expect(handler).toHaveBeenCalledWith(info.id, -1);
    expect(sm.getInfo(info.id)).toBeUndefined();
    sm.off('exit', handler);
  });

  it('kill handles already-exited sessions', () => {
    const info = sm.spawn();

    // Force session to exited via pollExits
    setupTmuxMock({ 'list-sessions': '' });
    vi.advanceTimersByTime(2000);

    // Session is now exited, kill should still succeed (cleanup)
    expect(sm.kill(info.id)).toBe(true);
    expect(sm.getInfo(info.id)).toBeUndefined();
  });

  it('kill returns false for nonexistent session', () => {
    expect(sm.kill('nonexistent')).toBe(false);
  });

  it('killAll removes all sessions', () => {
    sm.spawn();
    sm.spawn();
    sm.spawn();
    expect(sm.count()).toBe(3);
    sm.killAll();
    expect(sm.count()).toBe(0);
  });

  it('kill cleans up pipe file and metadata', () => {
    const info = sm.spawn();
    vi.clearAllMocks();
    setupTmuxMock();

    sm.kill(info.id);

    // Should unlink pipe file and metadata
    const unlinkCalls = mockUnlinkSync.mock.calls.map((c) => c[0] as string);
    expect(unlinkCalls.some((p) => p.includes('.pipe'))).toBe(true);
    expect(unlinkCalls.some((p) => p.includes('.json'))).toBe(true);
  });

  // ── setTask ───────────────────────────────────────────────────────────────

  it('setTask updates task and persists metadata', () => {
    const info = sm.spawn();
    vi.clearAllMocks();

    expect(sm.setTask(info.id, 'new task')).toBe(true);
    const updated = sm.getInfo(info.id)!;
    expect(updated.task).toBe('new task');
    expect(updated.taskStartedAt).toBeTruthy();

    // Should persist metadata
    const metaWrites = mockWriteFileSync.mock.calls.filter(
      (c) => (c[0] as string).includes('sessions/'),
    );
    expect(metaWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('setTask returns false for nonexistent session', () => {
    expect(sm.setTask('nonexistent', 'task')).toBe(false);
  });

  // ── getScrollback / getTranscript ─────────────────────────────────────────

  it('getScrollback returns empty for nonexistent session', () => {
    expect(sm.getScrollback('nonexistent')).toEqual([]);
  });

  it('getTranscript returns empty for nonexistent session', () => {
    expect(sm.getTranscript('nonexistent')).toEqual([]);
  });

  // ── pollExits ─────────────────────────────────────────────────────────────

  it('detects exited sessions via poll', () => {
    const info = sm.spawn();
    const handler = vi.fn();
    sm.on('exit', handler);

    // Session disappears from tmux
    setupTmuxMock({ 'list-sessions': '' });
    vi.advanceTimersByTime(2000);

    expect(handler).toHaveBeenCalledWith(info.id, null);
    expect(sm.getInfo(info.id)!.status).toBe('exited');
    sm.off('exit', handler);
  });

  it('does not mark sessions as exited if tmux reports them running', () => {
    const info = sm.spawn();
    const tmuxName = `bb-${info.id}`;

    setupTmuxMock({ 'list-sessions': tmuxName });
    vi.advanceTimersByTime(2000);

    expect(sm.getInfo(info.id)!.status).toBe('running');
  });

  it('logs warning on unexpected tmux poll error', () => {
    sm.spawn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Simulate an unexpected error (not exit code 1)
    mockExec.mockImplementation((_cmd: any, args: any) => {
      const subCmd = (args as string[])?.[0];
      if (subCmd === 'list-sessions') {
        const err = new Error('timeout') as any;
        err.status = 124; // not 1
        throw err;
      }
      return '' as any;
    });

    vi.advanceTimersByTime(2000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tmux list-sessions failed'));
    warnSpy.mockRestore();
  });

  // ── recover ───────────────────────────────────────────────────────────────

  it('recovers existing tmux sessions', async () => {
    setupTmuxMock({
      'list-sessions': 'bb-abc12345\nother-session',
      'display-message': '/home/user/project',
      'list-panes': '99999',
      'capture-pane': '❯ ',
    });
    mockExistsSync.mockReturnValue(false); // no existing metadata

    const count = await sm.recover();

    expect(count).toBe(1);
    expect(sm.count()).toBe(1);
    const sessions = sm.list();
    expect(sessions[0].name).toBe('Recovered abc12345');
    expect(sessions[0].group).toBe('recovered');
  });

  it('recovers sessions with persisted metadata', async () => {
    const meta: SessionInfo = {
      id: 'def67890',
      name: 'my-worker',
      group: 'project',
      cwd: '/home/user/app',
      status: 'exited', // will be overridden to running
      detailedState: 'error', // will be overridden to idle
      exitCode: 1,
      pid: null,
      createdAt: '2024-01-01T00:00:00Z',
      cols: 120,
      rows: 40,
      lastActivityAt: '2024-01-01T00:00:00Z',
      task: 'do stuff',
      taskStartedAt: '2024-01-01T00:00:00Z',
      compactionCount: 3,
      totalWorkingMs: 10000,
      totalIdleMs: 5000,
      totalPermissionWaitMs: 2000,
    };

    setupTmuxMock({
      'list-sessions': 'bb-def67890',
      'capture-pane': '',
    });
    mockExistsSync.mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('def67890.json')) return true;
      return true;
    });
    const { readFileSync } = await import('fs');
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(meta));

    const count = await sm.recover();

    expect(count).toBe(1);
    const sessions = sm.list();
    expect(sessions[0].name).toBe('my-worker');
    expect(sessions[0].group).toBe('project');
    expect(sessions[0].status).toBe('running');
    expect(sessions[0].detailedState).toBe('idle');
  });

  it('recover returns 0 when no tmux server', async () => {
    mockExec.mockImplementation(() => { throw new Error('no tmux'); });
    const count = await sm.recover();
    expect(count).toBe(0);
  });

  it('skips sessions that fail pipe-pane attachment', async () => {
    let callCount = 0;
    mockExec.mockImplementation((_cmd: any, args: any) => {
      const subCmd = (args as string[])?.[0];
      if (subCmd === 'list-sessions') return 'bb-fail01' as any;
      if (subCmd === 'pipe-pane') {
        callCount++;
        throw new Error('pipe-pane failed');
      }
      if (subCmd === 'display-message') return '/tmp' as any;
      if (subCmd === 'list-panes') return '12345' as any;
      return '' as any;
    });
    mockExistsSync.mockReturnValue(false);

    const count = await sm.recover();
    expect(count).toBe(0);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe('isTmuxAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when tmux is installed', () => {
    mockExec.mockReturnValue('tmux 3.4' as any);
    expect(isTmuxAvailable()).toBe(true);
  });

  it('returns false when tmux is not installed', () => {
    mockExec.mockImplementation(() => { throw new Error('not found'); });
    expect(isTmuxAvailable()).toBe(false);
  });
});
