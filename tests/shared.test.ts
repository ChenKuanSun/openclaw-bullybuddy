import { describe, it, expect } from 'vitest';
import { isAllowedArg, sanitizeColsRows, SENSITIVE_ENV_KEYS, MAX_SESSIONS, MAX_SCROLLBACK_BYTES } from '../src/server/shared.js';

describe('isAllowedArg', () => {
  it('allows exact flag matches', () => {
    expect(isAllowedArg('--model')).toBe(true);
    expect(isAllowedArg('-m')).toBe(true);
    expect(isAllowedArg('--verbose')).toBe(true);
    expect(isAllowedArg('--dangerously-skip-permissions')).toBe(true);
  });

  it('allows flag=value form for known flags', () => {
    expect(isAllowedArg('--model=sonnet')).toBe(true);
    expect(isAllowedArg('-m=sonnet')).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(isAllowedArg('--unknown')).toBe(false);
    expect(isAllowedArg('-z')).toBe(false);
    expect(isAllowedArg('--exec')).toBe(false);
  });

  it('rejects unknown flag=value forms', () => {
    expect(isAllowedArg('--exec=rm')).toBe(false);
  });

  it('allows positional args (non-flag values)', () => {
    expect(isAllowedArg('sonnet')).toBe(true);
    expect(isAllowedArg('some-value')).toBe(true);
    expect(isAllowedArg('/path/to/something')).toBe(true);
  });
});

describe('sanitizeColsRows', () => {
  it('returns value when within bounds', () => {
    expect(sanitizeColsRows(80, 120)).toBe(80);
    expect(sanitizeColsRows(24, 40)).toBe(24);
  });

  it('returns fallback for undefined', () => {
    expect(sanitizeColsRows(undefined, 120)).toBe(120);
  });

  it('returns fallback for non-finite values', () => {
    expect(sanitizeColsRows(NaN, 120)).toBe(120);
    expect(sanitizeColsRows(Infinity, 120)).toBe(120);
    expect(sanitizeColsRows(-Infinity, 120)).toBe(120);
  });

  it('clamps to minimum of 1', () => {
    expect(sanitizeColsRows(0, 120)).toBe(1);
    expect(sanitizeColsRows(-5, 120)).toBe(1);
  });

  it('clamps to maximum of 500', () => {
    expect(sanitizeColsRows(600, 120)).toBe(500);
    expect(sanitizeColsRows(999, 120)).toBe(500);
  });

  it('rounds to nearest integer', () => {
    expect(sanitizeColsRows(80.7, 120)).toBe(81);
    expect(sanitizeColsRows(80.3, 120)).toBe(80);
  });
});

describe('shared constants', () => {
  it('SENSITIVE_ENV_KEYS contains expected keys', () => {
    expect(SENSITIVE_ENV_KEYS).toContain('BB_TOKEN');
    expect(SENSITIVE_ENV_KEYS).toContain('BB_HOST');
    expect(SENSITIVE_ENV_KEYS).toContain('BB_PORT');
  });

  it('MAX_SESSIONS is 100', () => {
    expect(MAX_SESSIONS).toBe(100);
  });

  it('MAX_SCROLLBACK_BYTES is 2MB', () => {
    expect(MAX_SCROLLBACK_BYTES).toBe(2 * 1024 * 1024);
  });
});
