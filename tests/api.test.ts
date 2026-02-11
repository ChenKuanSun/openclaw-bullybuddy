import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';

vi.mock('node-pty', async () => {
  const { ptyMockFactory } = await import('./pty-mock.js');
  return ptyMockFactory();
});

import { SessionManager } from '../src/server/session-manager.js';
import { createApiHandler } from '../src/server/api.js';
import { spawnedPtys } from './pty-mock.js';

const TEST_TOKEN = 'test-token-123';

function startServer(sm: SessionManager): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const handler = createApiHandler(sm, TEST_TOKEN);
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

function api(port: number, path: string, opts?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(opts?.headers as Record<string, string>),
    },
  });
}

describe('REST API', () => {
  let sm: SessionManager;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    sm = new SessionManager();
    const s = await startServer(sm);
    server = s.server;
    port = s.port;
  });

  afterAll(() => {
    sm.killAll();
    server.close();
  });

  afterEach(() => {
    sm.killAll();
    spawnedPtys.length = 0;
  });

  // ── Auth ──

  it('rejects API calls without token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it('accepts API calls with Bearer token', async () => {
    const res = await api(port, '/api/sessions');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('accepts API calls with query token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${TEST_TOKEN}`);
    expect(res.status).toBe(200);
  });

  // ── Health ──

  it('GET /health returns server info', async () => {
    const res = await api(port, '/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.uptime).toBeGreaterThan(0);
    expect(json.data.sessions).toBe(0);
  });

  // ── Sessions CRUD ──

  it('POST /api/sessions spawns a session', async () => {
    const res = await api(port, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ name: 'test', group: 'g1' }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe('test');
    expect(json.data.group).toBe('g1');
    expect(json.data.status).toBe('running');
  });

  it('GET /api/sessions lists sessions', async () => {
    sm.spawn({ name: 'a', group: 'g1' });
    sm.spawn({ name: 'b', group: 'g2' });
    const res = await api(port, '/api/sessions');
    const json = await res.json();
    expect(json.data).toHaveLength(2);
  });

  it('GET /api/sessions?group= filters by group', async () => {
    sm.spawn({ group: 'x' });
    sm.spawn({ group: 'y' });
    sm.spawn({ group: 'x' });
    const res = await api(port, '/api/sessions?group=x');
    const json = await res.json();
    expect(json.data).toHaveLength(2);
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const info = sm.spawn({ name: 'detail-test' });
    const res = await api(port, `/api/sessions/${info.id}`);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.name).toBe('detail-test');
  });

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    const res = await api(port, '/api/sessions/nonexistent');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/sessions/:id kills a session', async () => {
    const info = sm.spawn({ name: 'to-kill' });
    const res = await api(port, `/api/sessions/${info.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(sm.getInfo(info.id)).toBeUndefined();
  });

  it('POST /api/sessions/:id/input sends input', async () => {
    const info = sm.spawn();
    const res = await api(port, `/api/sessions/${info.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ data: 'hello\n' }),
    });
    expect(res.status).toBe(200);
    expect(spawnedPtys[0].written).toContain('hello\n');
  });

  it('POST /api/sessions/:id/resize resizes PTY', async () => {
    const info = sm.spawn();
    const res = await api(port, `/api/sessions/${info.id}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ cols: 200, rows: 50 }),
    });
    expect(res.status).toBe(200);
    expect(spawnedPtys[0].cols).toBe(200);
    expect(spawnedPtys[0].rows).toBe(50);
  });

  // ── Groups ──

  it('GET /api/groups returns group info', async () => {
    sm.spawn({ group: 'g1' });
    sm.spawn({ group: 'g1' });
    sm.spawn({ group: 'g2' });
    const res = await api(port, '/api/groups');
    const json = await res.json();
    expect(json.ok).toBe(true);
    const g1 = json.data.find((g: any) => g.name === 'g1');
    expect(g1.sessionCount).toBe(2);
  });

  // ── Browse (security) ──

  it('GET /api/browse returns directories', async () => {
    const res = await api(port, '/api/browse');
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.path).toBeTruthy();
    expect(Array.isArray(json.data.dirs)).toBe(true);
  });

  it('GET /api/browse rejects paths outside home', async () => {
    const res = await api(port, '/api/browse?path=/etc');
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain('restricted');
  });

  // ── Summary ──

  it('GET /api/summary returns aggregate state counts', async () => {
    sm.spawn({ group: 'a' });
    sm.spawn({ group: 'b' });
    const res = await api(port, '/api/summary');
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.running).toBe(2);
    expect(Array.isArray(json.data.groups)).toBe(true);
    expect(Array.isArray(json.data.sessionsNeedingAttention)).toBe(true);
  });

  // ── Set Task ──

  it('POST /api/sessions/:id/task sets task metadata', async () => {
    const info = sm.spawn();
    const res = await api(port, `/api/sessions/${info.id}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ task: 'fix the bug' }),
    });
    expect(res.status).toBe(200);
    const updated = sm.getInfo(info.id)!;
    expect(updated.task).toBe('fix the bug');
    expect(updated.taskStartedAt).toBeTruthy();
  });

  it('POST /api/sessions/:id/task returns 404 for unknown session', async () => {
    const res = await api(port, '/api/sessions/nonexistent/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ task: 'something' }),
    });
    expect(res.status).toBe(404);
  });

  // ── Spawn with task ──

  it('POST /api/sessions with task stores task metadata', async () => {
    const res = await api(port, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ name: 'tasked', task: 'implement feature X' }),
    });
    const json = await res.json();
    expect(json.data.task).toBe('implement feature X');
    expect(json.data.taskStartedAt).toBeTruthy();
  });

  // ── Mute/unmute (L10) ──

  it('POST /api/sessions/:id/mute mutes a session', async () => {
    const info = sm.spawn();
    const res = await api(port, `/api/sessions/${info.id}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.muted).toBe(true);
  });

  it('POST /api/sessions/:id/unmute unmutes a session', async () => {
    const info = sm.spawn();
    // Mute first
    await api(port, `/api/sessions/${info.id}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    });
    // Then unmute
    const res = await api(port, `/api/sessions/${info.id}/unmute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.muted).toBe(false);
  });

  it('POST /api/sessions/:id/mute returns 404 for unknown session', async () => {
    const res = await api(port, '/api/sessions/nonexistent/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  // ── Content-Type check (M8) ──

  it('returns 415 for non-JSON Content-Type on POST', async () => {
    const info = sm.spawn();
    const res = await api(port, `/api/sessions/${info.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TEST_TOKEN}` },
      body: '{"data": "hello"}',
    });
    expect(res.status).toBe(415);
  });

  // ── Audit endpoint ──

  it('GET /api/audit returns audit entries', async () => {
    // Spawn a session to generate an audit entry
    await api(port, '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ name: 'audit-test' }),
    });
    const res = await api(port, '/api/audit');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    const spawnEntry = json.data.find((e: any) => e.action === 'session:spawn');
    expect(spawnEntry).toBeTruthy();
  });

  // ── Transcript endpoint ──

  it('GET /api/sessions/:id/transcript returns transcript', async () => {
    const info = sm.spawn();
    sm.write(info.id, 'hello\r');
    const res = await api(port, `/api/sessions/${info.id}/transcript`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data[0].role).toBe('user');
  });

  // ── Dashboard auth (C3) ──

  it('dashboard returns 401 without token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);
  });

  // ── 404 ──

  it('returns 404 for unknown API routes', async () => {
    const res = await api(port, '/api/nonexistent');
    expect(res.status).toBe(404);
  });
});
