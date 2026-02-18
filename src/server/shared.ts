// Shared constants and utilities for both session managers (node-pty and tmux).

// Env vars to strip from child processes
export const SENSITIVE_ENV_KEYS = ['BB_TOKEN', 'BB_HOST', 'BB_PORT'];

export const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024; // 2MB
export const MAX_SESSIONS = 100;
export const MAX_TRANSCRIPT = parseInt(process.env.BB_TRANSCRIPT_SIZE ?? '500', 10);

// Whether to auto-add --dangerously-skip-permissions (default: false — opt-in only)
export const DEFAULT_SKIP_PERMISSIONS = process.env.BB_SKIP_PERMISSIONS?.toLowerCase() === 'true';

// Allowed claude CLI flags (allowlist approach — block unknown args for safety)
export const ALLOWED_FLAGS = new Set([
  '--model', '-m',
  '--print', '-p',
  '--resume', '-r',
  '--continue', '-c',
  '--dangerously-skip-permissions',
  '--verbose',
  '--version',
]);

// Additional flags from env (comma-separated, e.g. BB_EXTRA_ARGS="--output-format,--max-turns")
if (process.env.BB_EXTRA_ARGS) {
  for (const f of process.env.BB_EXTRA_ARGS.split(',')) {
    const trimmed = f.trim();
    if (trimmed) ALLOWED_FLAGS.add(trimmed);
  }
}

export function isAllowedArg(arg: string): boolean {
  if (ALLOWED_FLAGS.has(arg)) return true;
  if (arg.includes('=')) {
    const flag = arg.slice(0, arg.indexOf('='));
    if (ALLOWED_FLAGS.has(flag)) return true;
  }
  if (!arg.startsWith('-')) return true;
  return false;
}

export function sanitizeColsRows(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.round(value)));
}
