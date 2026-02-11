import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';

vi.mock('node-pty', async () => {
  const { ptyMockFactory } = await import('./pty-mock.js');
  return ptyMockFactory();
});

import { SessionManager } from '../src/server/session-manager.js';
import { WsBridge } from '../src/server/ws-bridge.js';
import { spawnedPtys } from './pty-mock.js';

const TEST_TOKEN = 'ws-test-token';

/**
 * Helper WS client that buffers all messages from the moment of connection.
 * This avoids race conditions where the server sends messages (e.g. session list)
 * before the test attaches its listener.
 */
class TestWsClient {
  ws: WebSocket;
  messages: any[] = [];
  private waiters: ((msg: any) => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (this.waiters.length > 0) {
        this.waiters.shift()!(msg);
      } else {
        this.messages.push(msg);
      }
    });
  }

  /** Returns the next message (from buffer or waits for one). */
  nextMessage(): Promise<any> {
    if (this.messages.length > 0) {
      return Promise.resolve(this.messages.shift());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(msg: object) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }
}

function connectWs(port: number, token?: string): Promise<TestWsClient> {
  const t = token ?? TEST_TOKEN;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${t}`);
    const client = new TestWsClient(ws);
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

function connectWsRaw(port: number, token?: string): Promise<WebSocket> {
  const t = token ?? TEST_TOKEN;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${t}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('WsBridge', () => {
  let sm: SessionManager;
  let server: Server;
  let bridge: WsBridge;
  let port: number;

  beforeAll(async () => {
    sm = new SessionManager();
    server = createServer();
    bridge = new WsBridge(server, sm, TEST_TOKEN);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    sm.killAll();
    bridge.close();
    server.close();
  });

  afterEach(() => {
    sm.killAll();
    spawnedPtys.length = 0;
  });

  it('rejects WebSocket connections without valid token', async () => {
    await expect(connectWsRaw(port, 'bad-token')).rejects.toThrow();
  });

  it('sends session list on connect', async () => {
    sm.spawn({ name: 'ws-test' });
    const client = await connectWs(port);
    const msg = await client.nextMessage();
    expect(msg.type).toBe('sessions');
    expect(msg.sessions).toHaveLength(1);
    expect(msg.sessions[0].name).toBe('ws-test');
    client.close();
  });

  it('streams output to subscribed clients', async () => {
    const info = sm.spawn();
    const client = await connectWs(port);

    // Consume initial sessions message
    await client.nextMessage();

    // Subscribe to the session
    client.send({ type: 'subscribe', sessionId: info.id, cols: 80, rows: 24 });

    // Give the server a moment to process the subscribe
    await new Promise((r) => setTimeout(r, 50));

    // Emit output from the PTY mock
    spawnedPtys[0].emitData('hello world');

    // Wait for batched output (16ms flush + margin)
    const msg = await client.nextMessage();
    expect(msg.type).toBe('output');
    expect(msg.sessionId).toBe(info.id);
    expect(msg.data).toBe('hello world');
    client.close();
  });

  it('forwards input from client to PTY', async () => {
    const info = sm.spawn();
    const client = await connectWs(port);
    await client.nextMessage(); // consume sessions list

    client.send({ type: 'input', sessionId: info.id, data: 'test input' });

    await new Promise((r) => setTimeout(r, 50));
    expect(spawnedPtys[0].written).toContain('test input');
    client.close();
  });

  it('broadcasts session:created to all clients', async () => {
    const client = await connectWs(port);
    await client.nextMessage(); // consume initial sessions list

    // Spawn a new session after client is connected — triggers broadcast
    sm.spawn({ name: 'broadcast-test' });

    const msg = await client.nextMessage();
    expect(msg.type).toBe('session:created');
    expect(msg.session.name).toBe('broadcast-test');
    client.close();
  });

  it('broadcasts session:exited when PTY exits', async () => {
    const info = sm.spawn();
    const client = await connectWs(port);
    await client.nextMessage(); // consume sessions list

    spawnedPtys[0].emitExit(42);

    const msg = await client.nextMessage();
    expect(msg.type).toBe('session:exited');
    expect(msg.sessionId).toBe(info.id);
    expect(msg.exitCode).toBe(42);
    client.close();
  });

  it('stops streaming after unsubscribe', async () => {
    const info = sm.spawn();
    const client = await connectWs(port);
    await client.nextMessage(); // consume sessions list

    client.send({ type: 'subscribe', sessionId: info.id });
    await new Promise((r) => setTimeout(r, 50));

    client.send({ type: 'unsubscribe', sessionId: info.id });
    await new Promise((r) => setTimeout(r, 50));

    // Emit output — client should NOT receive it
    spawnedPtys[0].emitData('should not arrive');
    await new Promise((r) => setTimeout(r, 50));

    // Set up a race: either we get a message (bad) or a timeout (good)
    const gotMessage = await Promise.race([
      client.nextMessage().then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 200)),
    ]);
    expect(gotMessage).toBe(false);
    client.close();
  });
});
