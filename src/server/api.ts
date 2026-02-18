import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { homedir } from 'os';
import { timingSafeEqual } from 'crypto';
import type { ISessionManager, ApiSpawnRequest, ApiSetTaskRequest, ApiInputRequest, ApiResizeRequest, ApiResponse, GroupInfo, DetailedState } from './types.js';
import { muteSession, unmuteSession } from './webhook.js';
import { auditLog, getAuditEntries } from './audit-log.js';

const DASHBOARD_DIR = resolve(import.meta.dirname ?? '.', '../../dist-dashboard');
const HOME_DIR = homedir();
const BROWSE_ENABLED = process.env.BB_ENABLE_BROWSE?.toLowerCase() === 'true';

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function json(res: ServerResponse, status: number, body: ApiResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function parseJson<T>(req: IncomingMessage): Promise<T> {
  const ct = req.headers['content-type'] ?? '';
  if (!ct.includes('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
  }
  const body = await readBody(req);
  return JSON.parse(body) as T;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

// Simple path param extraction: /api/sessions/:id → id
function matchRoute(
  url: string,
  method: string,
  pattern: string,
  expectedMethod: string,
): Record<string, string> | null {
  if (method !== expectedMethod) return null;

  const urlParts = url.split('/').filter(Boolean);
  const patParts = pattern.split('/').filter(Boolean);

  if (urlParts.length !== patParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = urlParts[i];
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

function serveDashboard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!existsSync(DASHBOARD_DIR)) return false;

  const url = (req.url ?? '/').split('?')[0];
  let filePath = url === '/' ? 'index.html' : url.slice(1);
  let fullPath = join(DASHBOARD_DIR, filePath);

  // SPA fallback: if file doesn't exist, serve index.html (for /lobster etc.)
  if ((!fullPath.startsWith(DASHBOARD_DIR + '/') && fullPath !== DASHBOARD_DIR) || !existsSync(fullPath)) {
    fullPath = join(DASHBOARD_DIR, 'index.html');
    if (!existsSync(fullPath)) return false;
    filePath = 'index.html';
  }

  // C2: Canonicalize with realpathSync to prevent path traversal
  let realPath: string;
  try {
    realPath = realpathSync(fullPath);
  } catch {
    return false;
  }
  if (!realPath.startsWith(DASHBOARD_DIR + '/') && realPath !== DASHBOARD_DIR + '/index.html') {
    return false;
  }

  const ext = realPath.split('.').pop() ?? '';
  const mimeTypes: Record<string, string> = {
    html: 'text/html',
    js: 'application/javascript',
    css: 'text/css',
    svg: 'image/svg+xml',
    png: 'image/png',
    ico: 'image/x-icon',
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(realPath));
  return true;
}

// M3: Simple in-memory rate limiter for spawn
const spawnTimestamps = new Map<string, number[]>();
const SPAWN_RATE_LIMIT = 10;
const SPAWN_RATE_WINDOW_MS = 60_000;

function checkSpawnRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = spawnTimestamps.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < SPAWN_RATE_WINDOW_MS);
  if (recent.length >= SPAWN_RATE_LIMIT) return false;
  recent.push(now);
  spawnTimestamps.set(ip, recent);
  return true;
}

// Periodic cleanup of stale rate limiter entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of spawnTimestamps) {
    const recent = timestamps.filter((t) => now - t < SPAWN_RATE_WINDOW_MS);
    if (recent.length === 0) {
      spawnTimestamps.delete(ip);
    } else {
      spawnTimestamps.set(ip, recent);
    }
  }
}, 5 * 60_000);

// M7: Dynamic CORS — allow localhost/127.0.0.1 on any port
function isAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createApiHandler(sessions: ISessionManager, authToken: string) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    const query = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams;
    const ip = clientIp(req);

    // CORS headers — restrict to localhost origins on any port
    const origin = req.headers.origin ?? '';
    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // C3: Auth check — require for /api/*, /health, AND dashboard
    if (url.startsWith('/api/') || url === '/health') {
      const tokenFromQuery = query.get('token');
      const authHeader = req.headers.authorization;
      const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const token = tokenFromQuery ?? tokenFromHeader;

      if (!token || !safeTokenCompare(token, authToken)) {
        json(res, 401, { ok: false, error: 'Unauthorized — invalid or missing token' });
        return;
      }
    }

    try {
      // ── Health ──
      if (url === '/health' && method === 'GET') {
        json(res, 200, {
          ok: true,
          data: {
            uptime: process.uptime(),
            sessions: sessions.count(),
          },
        });
        return;
      }

      // ── List sessions ──
      if (url === '/api/sessions' && method === 'GET') {
        const group = query.get('group') ?? undefined;
        json(res, 200, { ok: true, data: sessions.list(group) });
        return;
      }

      // ── Spawn session ──
      if (url === '/api/sessions' && method === 'POST') {
        if (!checkSpawnRateLimit(ip)) {
          auditLog({ action: 'session:spawn', source: 'rest', actor: ip, result: 'error', error: 'Rate limited' });
          json(res, 429, { ok: false, error: 'Too many spawn requests — max 10 per 60 seconds' });
          return;
        }
        const body = await parseJson<ApiSpawnRequest>(req);
        const info = sessions.spawn(body);
        auditLog({ action: 'session:spawn', sessionId: info.id, source: 'rest', actor: ip, summary: info.name, result: 'ok' });
        json(res, 201, { ok: true, data: info });
        return;
      }

      // ── Session detail ──
      let params = matchRoute(url, method, '/api/sessions/:id', 'GET');
      if (params) {
        const info = sessions.getInfo(params.id);
        if (!info) {
          json(res, 404, { ok: false, error: 'Session not found' });
          return;
        }
        json(res, 200, { ok: true, data: info });
        return;
      }

      // ── Send input ──
      params = matchRoute(url, method, '/api/sessions/:id/input', 'POST');
      if (params) {
        const body = await parseJson<ApiInputRequest>(req);
        const ok = sessions.write(params.id, body.data);
        if (!ok) {
          auditLog({ action: 'session:input', sessionId: params.id, source: 'rest', actor: ip, result: 'error', error: 'Not found or not running' });
          json(res, 404, { ok: false, error: 'Session not found or not running' });
          return;
        }
        auditLog({ action: 'session:input', sessionId: params.id, source: 'rest', actor: ip, summary: `${body.data.length} bytes`, result: 'ok' });
        json(res, 200, { ok: true });
        return;
      }

      // ── Resize ──
      params = matchRoute(url, method, '/api/sessions/:id/resize', 'POST');
      if (params) {
        const body = await parseJson<ApiResizeRequest>(req);
        const ok = sessions.resize(params.id, body.cols, body.rows);
        if (!ok) {
          json(res, 404, { ok: false, error: 'Session not found or not running' });
          return;
        }
        auditLog({ action: 'session:resize', sessionId: params.id, source: 'rest', actor: ip, summary: `${body.cols}x${body.rows}`, result: 'ok' });
        json(res, 200, { ok: true });
        return;
      }

      // ── Kill session ──
      params = matchRoute(url, method, '/api/sessions/:id', 'DELETE');
      if (params) {
        const ok = sessions.kill(params.id);
        if (!ok) {
          json(res, 404, { ok: false, error: 'Session not found' });
          return;
        }
        auditLog({ action: 'session:kill', sessionId: params.id, source: 'rest', actor: ip, result: 'ok' });
        json(res, 200, { ok: true });
        return;
      }

      // ── Mute/unmute webhook notifications ──
      params = matchRoute(url, method, '/api/sessions/:id/mute', 'POST');
      if (params) {
        const info = sessions.getInfo(params.id);
        if (!info) {
          json(res, 404, { ok: false, error: 'Session not found' });
          return;
        }
        muteSession(params.id);
        auditLog({ action: 'session:mute', sessionId: params.id, source: 'rest', actor: ip, result: 'ok' });
        json(res, 200, { ok: true, data: { muted: true } });
        return;
      }

      params = matchRoute(url, method, '/api/sessions/:id/unmute', 'POST');
      if (params) {
        const info = sessions.getInfo(params.id);
        if (!info) {
          json(res, 404, { ok: false, error: 'Session not found' });
          return;
        }
        unmuteSession(params.id);
        auditLog({ action: 'session:unmute', sessionId: params.id, source: 'rest', actor: ip, result: 'ok' });
        json(res, 200, { ok: true, data: { muted: false } });
        return;
      }

      // ── Set task ──
      params = matchRoute(url, method, '/api/sessions/:id/task', 'POST');
      if (params) {
        const body = await parseJson<ApiSetTaskRequest>(req);
        const ok = sessions.setTask(params.id, body.task);
        if (!ok) {
          json(res, 404, { ok: false, error: 'Session not found' });
          return;
        }
        auditLog({ action: 'session:setTask', sessionId: params.id, source: 'rest', actor: ip, summary: body.task.slice(0, 80), result: 'ok' });
        json(res, 200, { ok: true });
        return;
      }

      // ── Transcript ──
      params = matchRoute(url, method, '/api/sessions/:id/transcript', 'GET');
      if (params) {
        const transcript = sessions.getTranscript(params.id);
        const last = query.get('last');
        const data = last ? transcript.slice(-parseInt(last, 10)) : transcript;
        json(res, 200, { ok: true, data });
        return;
      }

      // ── Audit log ──
      if (url === '/api/audit' && method === 'GET') {
        const limit = query.get('limit') ? parseInt(query.get('limit')!, 10) : undefined;
        const sessionId = query.get('sessionId') ?? undefined;
        const action = query.get('action') ?? undefined;
        json(res, 200, { ok: true, data: getAuditEntries({ limit, sessionId, action }) });
        return;
      }

      // ── Browse directories (disabled by default, enable with BB_ENABLE_BROWSE=true) ──
      if (url === '/api/browse' && method === 'GET') {
        if (!BROWSE_ENABLED) {
          json(res, 403, { ok: false, error: 'Browse endpoint disabled. Set BB_ENABLE_BROWSE=true to enable.' });
          return;
        }
        const rawPath = query.get('path') ?? HOME_DIR;
        const absPath = resolve(rawPath);

        if (!existsSync(absPath)) {
          json(res, 404, { ok: false, error: 'Path not found' });
          return;
        }

        // Resolve symlinks before checking path boundary
        let realPath: string;
        try {
          realPath = realpathSync(absPath);
        } catch {
          json(res, 403, { ok: false, error: 'Cannot resolve path' });
          return;
        }

        // Restrict browsing to within the user's home directory (trailing slash prevents prefix confusion)
        if (realPath !== HOME_DIR && !realPath.startsWith(HOME_DIR + '/')) {
          json(res, 403, { ok: false, error: 'Access denied — browsing restricted to home directory' });
          return;
        }

        try {
          const entries = readdirSync(realPath, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.isSymbolicLink())
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          // Clamp parent to home directory boundary
          const parent = dirname(realPath);
          const safeParent = (parent === HOME_DIR || parent.startsWith(HOME_DIR + '/')) ? parent : HOME_DIR;
          auditLog({ action: 'browse', source: 'rest', actor: ip, summary: realPath, result: 'ok' });
          json(res, 200, { ok: true, data: { path: realPath, parent: safeParent, dirs } });
        } catch {
          json(res, 403, { ok: false, error: 'Cannot read directory' });
        }
        return;
      }

      // ── Groups ──
      if (url === '/api/groups' && method === 'GET') {
        const groups = sessions.groups();
        const result: GroupInfo[] = [];
        for (const [name, s] of groups) {
          result.push({ name, sessionCount: s.length, sessions: s });
        }
        json(res, 200, { ok: true, data: result });
        return;
      }

      // ── Summary ──
      if (url === '/api/summary' && method === 'GET') {
        const all = sessions.list();
        const stateCounts: Record<string, number> = {};
        const needsAttention: string[] = [];
        let running = 0;

        for (const s of all) {
          if (s.status === 'running') {
            running++;
            stateCounts[s.detailedState] = (stateCounts[s.detailedState] ?? 0) + 1;
            if (s.detailedState === 'permission_needed' || s.detailedState === 'error') {
              needsAttention.push(s.id);
            }
          }
        }

        const groupMap = sessions.groups();
        const groupSummaries: { name: string; running: number; states: Record<string, number> }[] = [];
        for (const [name, groupSessions] of groupMap) {
          const gs: Record<string, number> = {};
          let gr = 0;
          for (const s of groupSessions) {
            if (s.status === 'running') {
              gr++;
              gs[s.detailedState] = (gs[s.detailedState] ?? 0) + 1;
            }
          }
          groupSummaries.push({ name, running: gr, states: gs });
        }

        json(res, 200, {
          ok: true,
          data: {
            running,
            ...stateCounts,
            groups: groupSummaries,
            sessionsNeedingAttention: needsAttention,
          },
        });
        return;
      }

      // ── Dashboard fallback ──
      if (method === 'GET' && !url.startsWith('/api/')) {
        // C3: Require token for dashboard HTML, but allow static assets (CSS/JS/images)
        const isAsset = url.startsWith('/assets/') || /\.(css|js|svg|png|ico|woff2?)$/i.test(url);
        if (!isAsset) {
          const tokenFromQuery = query.get('token');
          if (!tokenFromQuery || !safeTokenCompare(tokenFromQuery, authToken)) {
            json(res, 401, { ok: false, error: 'Unauthorized — pass ?token= to access dashboard' });
            return;
          }
        }
        if (serveDashboard(req, res)) return;
      }

      json(res, 404, { ok: false, error: 'Not found' });
    } catch (err: any) {
      if (err?.statusCode === 415) {
        json(res, 415, { ok: false, error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal error';
      json(res, 500, { ok: false, error: message });
    }
  };
}
