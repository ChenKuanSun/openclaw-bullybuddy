import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateDetector } from '../src/server/state-detector.js';
import type { DetailedState } from '../src/server/state-detector.js';

describe('StateDetector', () => {
  let detector: StateDetector;
  let changes: { sessionId: string; state: DetailedState; prev: DetailedState }[];

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    detector = new StateDetector((sessionId, state, prev) => {
      changes.push({ sessionId, state, prev });
    });
  });

  it('starts in "starting" state', () => {
    expect(detector.getState('s1')).toBe('starting');
  });

  it('detects working state from spinner', () => {
    detector.feed('s1', '\x1b[36m✻\x1b[0m Thinking...');
    expect(detector.getState('s1')).toBe('working');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ sessionId: 's1', state: 'working', prev: 'starting' });
  });

  it('detects idle state from prompt', () => {
    detector.feed('s1', 'some output\n❯ ');
    expect(detector.getState('s1')).toBe('idle');
  });

  it('detects permission_needed from "Do you want to proceed?"', () => {
    detector.feed('s1', 'Some context here\nDo you want to proceed?\n(Y)es / No');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects permission_needed from accept edits prompt', () => {
    detector.feed('s1', '⏵⏵ accept edits to src/foo.ts?');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects permission_needed from trust folder prompt', () => {
    detector.feed('s1', 'Is this a project you created or one you trust?\n\n❯ 1. Yes, I trust this folder\n  2. No, exit\n\nEnter to confirm · Esc to cancel');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects permission_needed from quick safety check', () => {
    detector.feed('s1', 'Quick safety check\nSome description here');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects permission_needed from bypass permissions mode', () => {
    detector.feed('s1', 'Bypass Permissions mode\nThis mode allows Claude to run without asking for approval.');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects permission_needed from "Yes, I accept"', () => {
    detector.feed('s1', 'Do you accept the risks?\n❯ Yes, I accept\n  No, cancel');
    expect(detector.getState('s1')).toBe('permission_needed');
  });

  it('detects compacting state', () => {
    detector.feed('s1', '· Compacting conversation...');
    expect(detector.getState('s1')).toBe('compacting');
  });

  it('detects error from Error: at start of line', () => {
    detector.feed('s1', 'Error: ENOENT file not found\n');
    expect(detector.getState('s1')).toBe('error');
  });

  it('detects error from system error codes', () => {
    detector.feed('s1', 'spawn claude ENOENT\n');
    expect(detector.getState('s1')).toBe('error');
  });

  it('detects error from API errors', () => {
    detector.feed('s1', 'APIError: rate limit exceeded\n');
    expect(detector.getState('s1')).toBe('error');
  });

  it('does not false-positive on inline Error: in code output', () => {
    // Claude displaying code that contains "Error:" mid-line should not trigger error
    detector.feed('s1', '✻ Thinking...');
    expect(detector.getState('s1')).toBe('working');
    detector.feed('s1', '\n  console.log("Error: something went wrong");\n');
    // The "Error:" is mid-line (indented), not at start — should stay working
    expect(detector.getState('s1')).toBe('working');
  });

  it('transitions from working to idle after timeout', () => {
    detector.feed('s1', '✻ Working...');
    expect(detector.getState('s1')).toBe('working');

    vi.advanceTimersByTime(30_000);
    expect(detector.getState('s1')).toBe('idle');
    expect(changes.at(-1)).toEqual({ sessionId: 's1', state: 'idle', prev: 'working' });
  });

  it('resets idle timer on new output', () => {
    detector.feed('s1', '✻ Thinking...');
    vi.advanceTimersByTime(20_000);
    // More output resets the timer
    detector.feed('s1', '✻ Working...');
    vi.advanceTimersByTime(20_000);
    // Should still be working (40s total, but timer was reset at 20s)
    expect(detector.getState('s1')).toBe('working');

    vi.advanceTimersByTime(10_000);
    // Now 30s since last output
    expect(detector.getState('s1')).toBe('idle');
  });

  it('handles multiple sessions independently', () => {
    detector.feed('s1', '✻ Thinking...');
    detector.feed('s2', '❯ ');
    expect(detector.getState('s1')).toBe('working');
    expect(detector.getState('s2')).toBe('idle');
  });

  it('cleans up session on remove', () => {
    detector.feed('s1', '✻ Working...');
    detector.remove('s1');
    expect(detector.getState('s1')).toBe('starting');
  });

  it('transitions through multiple states', () => {
    detector.feed('s1', '✻ Thinking...');
    expect(detector.getState('s1')).toBe('working');

    detector.feed('s1', '\nDo you want to proceed?\n');
    expect(detector.getState('s1')).toBe('permission_needed');

    detector.feed('s1', '\n✻ Working on changes...');
    expect(detector.getState('s1')).toBe('working');

    detector.feed('s1', '\n❯ ');
    expect(detector.getState('s1')).toBe('idle');
  });

  it('handles ANSI-decorated output', () => {
    detector.feed('s1', '\x1b[1m\x1b[36m✻\x1b[0m \x1b[2mThinking...\x1b[0m');
    expect(detector.getState('s1')).toBe('working');
  });

  // ── Time metrics ──────────────────────────────────────────────────────────

  it('tracks working time', () => {
    detector.feed('s1', '✻ Thinking...');
    vi.advanceTimersByTime(5000);
    const m = detector.getMetrics('s1');
    expect(m.totalWorkingMs).toBe(5000);
    expect(m.totalIdleMs).toBe(0);
  });

  it('accumulates time across state transitions', () => {
    detector.feed('s1', '✻ Thinking...');
    vi.advanceTimersByTime(3000);

    detector.feed('s1', '\nDo you want to proceed?\n');
    vi.advanceTimersByTime(2000);

    detector.feed('s1', '\n✻ Working on changes...');
    vi.advanceTimersByTime(1000);

    const m = detector.getMetrics('s1');
    expect(m.totalWorkingMs).toBe(3000 + 1000);
    expect(m.totalPermissionWaitMs).toBe(2000);
  });

  it('tracks idle time', () => {
    detector.feed('s1', '❯ ');
    vi.advanceTimersByTime(10_000);
    const m = detector.getMetrics('s1');
    expect(m.totalIdleMs).toBe(10_000);
  });

  it('returns zero metrics for unknown session', () => {
    const m = detector.getMetrics('nonexistent');
    expect(m.totalWorkingMs).toBe(0);
    expect(m.totalIdleMs).toBe(0);
    expect(m.totalPermissionWaitMs).toBe(0);
  });
});
