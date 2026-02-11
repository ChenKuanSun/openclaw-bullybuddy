import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Reset module state between tests by using dynamic import
let auditLog: typeof import('../src/server/audit-log.js').auditLog;
let getAuditEntries: typeof import('../src/server/audit-log.js').getAuditEntries;

describe('AuditLog', () => {
  beforeEach(async () => {
    // Re-import to reset module state
    vi.resetModules();
    const mod = await import('../src/server/audit-log.js');
    auditLog = mod.auditLog;
    getAuditEntries = mod.getAuditEntries;
  });

  it('records and retrieves audit entries', () => {
    auditLog({ action: 'session:spawn', sessionId: 's1', source: 'rest', actor: '127.0.0.1', result: 'ok' });
    auditLog({ action: 'session:kill', sessionId: 's1', source: 'rest', actor: '127.0.0.1', result: 'ok' });

    const entries = getAuditEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('session:spawn');
    expect(entries[0].timestamp).toBeTruthy();
    expect(entries[1].action).toBe('session:kill');
  });

  it('filters by sessionId', () => {
    auditLog({ action: 'session:spawn', sessionId: 's1', source: 'rest', result: 'ok' });
    auditLog({ action: 'session:spawn', sessionId: 's2', source: 'rest', result: 'ok' });
    auditLog({ action: 'session:kill', sessionId: 's1', source: 'rest', result: 'ok' });

    const entries = getAuditEntries({ sessionId: 's1' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.sessionId === 's1')).toBe(true);
  });

  it('filters by action', () => {
    auditLog({ action: 'session:spawn', sessionId: 's1', source: 'rest', result: 'ok' });
    auditLog({ action: 'session:kill', sessionId: 's1', source: 'rest', result: 'ok' });
    auditLog({ action: 'session:spawn', sessionId: 's2', source: 'rest', result: 'ok' });

    const entries = getAuditEntries({ action: 'session:spawn' });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.action === 'session:spawn')).toBe(true);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      auditLog({ action: 'session:spawn', source: 'rest', result: 'ok' });
    }
    const entries = getAuditEntries({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('defaults limit to 50', () => {
    for (let i = 0; i < 60; i++) {
      auditLog({ action: 'session:spawn', source: 'rest', result: 'ok' });
    }
    const entries = getAuditEntries();
    expect(entries).toHaveLength(50);
  });

  it('evicts old entries when exceeding ring buffer size', async () => {
    // Use a small ring buffer via env var
    vi.resetModules();
    process.env.BB_AUDIT_LOG_SIZE = '5';
    const mod = await import('../src/server/audit-log.js');

    for (let i = 0; i < 10; i++) {
      mod.auditLog({ action: `action-${i}`, source: 'rest', result: 'ok' });
    }

    const entries = mod.getAuditEntries({ limit: 100 });
    expect(entries).toHaveLength(5);
    expect(entries[0].action).toBe('action-5');

    delete process.env.BB_AUDIT_LOG_SIZE;
  });

  it('records error entries', () => {
    auditLog({ action: 'session:spawn', source: 'rest', result: 'error', error: 'Rate limited' });

    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('error');
    expect(entries[0].error).toBe('Rate limited');
  });
});
