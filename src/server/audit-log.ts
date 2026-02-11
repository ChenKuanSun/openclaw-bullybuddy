import { appendFileSync } from 'fs';
import type { AuditEntry, AuditQueryOptions } from './types.js';

const MAX_SIZE = parseInt(process.env.BB_AUDIT_LOG_SIZE ?? '1000', 10);
const LOG_FILE = process.env.BB_AUDIT_LOG_FILE ?? '';

const entries: AuditEntry[] = [];

export function auditLog(entry: Omit<AuditEntry, 'timestamp'>): void {
  const full: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
  entries.push(full);
  if (entries.length > MAX_SIZE) {
    entries.splice(0, entries.length - MAX_SIZE);
  }
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, JSON.stringify(full) + '\n');
    } catch {
      // Silently ignore file write failures
    }
  }
}

export function getAuditEntries(opts: AuditQueryOptions = {}): AuditEntry[] {
  let result = entries;
  if (opts.sessionId) {
    result = result.filter((e) => e.sessionId === opts.sessionId);
  }
  if (opts.action) {
    result = result.filter((e) => e.action === opts.action);
  }
  const limit = opts.limit ?? 50;
  return result.slice(-limit);
}
