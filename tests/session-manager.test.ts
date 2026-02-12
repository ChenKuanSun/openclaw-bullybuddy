import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// vi.mock is hoisted — the factory must not reference local variables.
// We import from pty-mock inside the factory via dynamic import workaround.
vi.mock('node-pty', async () => {
  const { ptyMockFactory } = await import('./pty-mock.js');
  return ptyMockFactory();
});

// Import after mock is installed
import { SessionManager } from '../src/server/session-manager.js';
import { spawnedPtys } from './pty-mock.js';

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    spawnedPtys.length = 0;
    sm = new SessionManager();
  });

  afterEach(() => {
    sm.killAll();
  });

  it('spawns a session with auto-generated name and id', () => {
    const info = sm.spawn();
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    expect(info.name).toBe('Claude');
    expect(info.group).toBe('default');
    expect(info.status).toBe('running');
    expect(info.pid).toBe(12345);
    expect(spawnedPtys).toHaveLength(1);
  });

  it('auto-names sessions sequentially', () => {
    const a = sm.spawn();
    const b = sm.spawn();
    const c = sm.spawn();
    expect(a.name).toBe('Claude');
    expect(b.name).toBe('Claude 2');
    expect(c.name).toBe('Claude 3');
  });

  it('respects custom name and group', () => {
    const info = sm.spawn({ name: 'test-worker', group: 'mygroup', cwd: '/tmp' });
    expect(info.name).toBe('test-worker');
    expect(info.group).toBe('mygroup');
    expect(info.cwd).toBe('/tmp');
  });

  it('lists sessions, optionally filtered by group', () => {
    sm.spawn({ group: 'a' });
    sm.spawn({ group: 'b' });
    sm.spawn({ group: 'a' });
    expect(sm.list()).toHaveLength(3);
    expect(sm.list('a')).toHaveLength(2);
    expect(sm.list('b')).toHaveLength(1);
    expect(sm.list('nonexistent')).toHaveLength(0);
  });

  it('returns groups map', () => {
    sm.spawn({ group: 'x' });
    sm.spawn({ group: 'y' });
    sm.spawn({ group: 'x' });
    const groups = sm.groups();
    expect(groups.get('x')).toHaveLength(2);
    expect(groups.get('y')).toHaveLength(1);
  });

  it('writes input to session PTY', () => {
    const info = sm.spawn();
    expect(sm.write(info.id, 'hello')).toBe(true);
    expect(spawnedPtys[0].written).toContain('hello');
  });

  it('write returns false for nonexistent session', () => {
    expect(sm.write('nonexistent', 'data')).toBe(false);
  });

  it('resizes PTY', () => {
    const info = sm.spawn({ cols: 80, rows: 24 });
    expect(sm.resize(info.id, 200, 50)).toBe(true);
    expect(spawnedPtys[0].cols).toBe(200);
    expect(spawnedPtys[0].rows).toBe(50);
    expect(sm.getInfo(info.id)!.cols).toBe(200);
    expect(sm.getInfo(info.id)!.rows).toBe(50);
  });

  it('buffers scrollback from PTY output', () => {
    const info = sm.spawn();
    spawnedPtys[0].emitData('line 1\n');
    spawnedPtys[0].emitData('line 2\n');
    const sb = sm.getScrollback(info.id);
    expect(sb).toEqual(['line 1\n', 'line 2\n']);
  });

  it('emits output events', () => {
    const info = sm.spawn();
    const handler = vi.fn();
    sm.on('output', handler);
    spawnedPtys[0].emitData('test data');
    expect(handler).toHaveBeenCalledWith(info.id, 'test data');
    sm.off('output', handler);
  });

  it('handles PTY exit', () => {
    const info = sm.spawn();
    const handler = vi.fn();
    sm.on('exit', handler);
    spawnedPtys[0].emitExit(0);
    expect(handler).toHaveBeenCalledWith(info.id, 0);
    expect(sm.getInfo(info.id)!.status).toBe('exited');
    expect(sm.getInfo(info.id)!.exitCode).toBe(0);
    expect(sm.getInfo(info.id)!.pid).toBeNull();
    sm.off('exit', handler);
  });

  it('kills a session and disposes listeners', () => {
    const info = sm.spawn();
    expect(sm.kill(info.id)).toBe(true);
    expect(spawnedPtys[0].killed).toBe(true);
    expect(sm.getInfo(info.id)).toBeUndefined();
    // After kill, emitting data should not throw (listeners disposed)
    expect(() => spawnedPtys[0].emitData('after kill')).not.toThrow();
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

  it('emits created event on spawn', () => {
    const handler = vi.fn();
    sm.on('created', handler);
    const info = sm.spawn({ name: 'test' });
    expect(handler).toHaveBeenCalledWith(info);
    sm.off('created', handler);
  });

  it('does not write to exited session', () => {
    const info = sm.spawn();
    spawnedPtys[0].emitExit(1);
    expect(sm.write(info.id, 'data')).toBe(false);
  });

  // ── Task tracking ─────────────────────────────────────────────────────────

  it('stores task on spawn', () => {
    const info = sm.spawn({ task: 'fix the login bug' });
    expect(info.task).toBe('fix the login bug');
    expect(info.taskStartedAt).toBeTruthy();
  });

  it('defaults task to null when not provided', () => {
    const info = sm.spawn();
    expect(info.task).toBeNull();
    expect(info.taskStartedAt).toBeNull();
  });

  it('setTask updates task and taskStartedAt', () => {
    const info = sm.spawn();
    expect(info.task).toBeNull();
    const ok = sm.setTask(info.id, 'new task');
    expect(ok).toBe(true);
    const updated = sm.getInfo(info.id)!;
    expect(updated.task).toBe('new task');
    expect(updated.taskStartedAt).toBeTruthy();
  });

  it('setTask returns false for nonexistent session', () => {
    expect(sm.setTask('nonexistent', 'task')).toBe(false);
  });

  it('initializes compactionCount to 0', () => {
    const info = sm.spawn();
    expect(info.compactionCount).toBe(0);
  });

  it('initializes time metrics to 0', () => {
    const info = sm.spawn();
    expect(info.totalWorkingMs).toBe(0);
    expect(info.totalIdleMs).toBe(0);
    expect(info.totalPermissionWaitMs).toBe(0);
  });

  // ── skipPermissions ──────────────────────────────────────────────────────

  it('does not add --dangerously-skip-permissions by default', () => {
    sm.spawn();
    expect(spawnedPtys[0].spawnArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('adds --dangerously-skip-permissions when skipPermissions is true', () => {
    sm.spawn({ skipPermissions: true });
    expect(spawnedPtys[0].spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions when skipPermissions is false', () => {
    sm.spawn({ skipPermissions: false });
    expect(spawnedPtys[0].spawnArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('strips --dangerously-skip-permissions from args when skipPermissions is false', () => {
    sm.spawn({ args: ['--dangerously-skip-permissions', '--verbose'], skipPermissions: false });
    expect(spawnedPtys[0].spawnArgs).not.toContain('--dangerously-skip-permissions');
    expect(spawnedPtys[0].spawnArgs).toContain('--verbose');
  });

  it('skipPermissions true overrides env default', () => {
    sm.spawn({ skipPermissions: true });
    expect(spawnedPtys[0].spawnArgs).toContain('--dangerously-skip-permissions');
  });

  it('auto-sends task when session reaches idle state', () => {
    const info = sm.spawn({ task: 'do the thing' });
    // Simulate Claude reaching idle prompt
    spawnedPtys[0].emitData('❯ ');
    // Should have auto-written the task
    expect(spawnedPtys[0].written).toContain('do the thing\r');
  });

  // ── BB_SKIP_PERMISSIONS env var ─────────────────────────────────────────

  it('omits --dangerously-skip-permissions when BB_SKIP_PERMISSIONS=false', async () => {
    // Must re-import module to pick up env var at module evaluation time
    vi.resetModules();
    process.env.BB_SKIP_PERMISSIONS = 'false';

    // Re-mock node-pty for the fresh module graph
    vi.doMock('node-pty', async () => {
      const { ptyMockFactory } = await import('./pty-mock.js');
      return ptyMockFactory();
    });

    const { SessionManager: SM2 } = await import('../src/server/session-manager.js');
    const { spawnedPtys: ptys2 } = await import('./pty-mock.js');
    const prevLen = ptys2.length;

    const sm2 = new SM2();
    sm2.spawn();
    expect(ptys2[prevLen].spawnArgs).not.toContain('--dangerously-skip-permissions');
    sm2.killAll();

    delete process.env.BB_SKIP_PERMISSIONS;
  });

  // ── Transcript ──────────────────────────────────────────────────────────

  it('records user input as transcript entry', () => {
    const info = sm.spawn();
    sm.write(info.id, 'hello world\r');
    const transcript = sm.getTranscript(info.id);
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe('user');
    expect(transcript[0].content).toBe('hello world');
    expect(transcript[0].timestamp).toBeTruthy();
  });

  it('captures assistant response on working→idle transition', () => {
    const info = sm.spawn();
    // User sends input
    sm.write(info.id, 'do something\r');
    // Simulate Claude working
    spawnedPtys[0].emitData('✻ Thinking...');
    // Simulate Claude's response
    spawnedPtys[0].emitData('\nHere is my response\n');
    // Transition to idle
    spawnedPtys[0].emitData('❯ ');

    const transcript = sm.getTranscript(info.id);
    // Should have user + assistant entries
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    const assistant = transcript.find((e) => e.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant!.content).toContain('response');
  });

  it('getTranscript returns entries for session', () => {
    const info = sm.spawn();
    sm.write(info.id, 'test\r');
    expect(sm.getTranscript(info.id)).toHaveLength(1);
  });

  it('getTranscript returns empty array for nonexistent session', () => {
    expect(sm.getTranscript('nonexistent')).toEqual([]);
  });

  // ── Scrollback returns copy ─────────────────────────────────────────────

  it('getScrollback returns a copy (not reference)', () => {
    const info = sm.spawn();
    spawnedPtys[0].emitData('data');
    const sb1 = sm.getScrollback(info.id);
    const sb2 = sm.getScrollback(info.id);
    expect(sb1).toEqual(sb2);
    // Mutating the returned array should not affect internal state
    sb1.push('extra');
    expect(sm.getScrollback(info.id)).not.toContain('extra');
  });
});
