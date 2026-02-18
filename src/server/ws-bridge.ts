import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { timingSafeEqual } from 'crypto';
import type { ISessionManager, DetailedState, WsClientMessage, WsServerMessage } from './types.js';
import { auditLog } from './audit-log.js';

function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  ip: string;
}

const MAX_CLIENTS = 50;
const MAX_INPUT_BYTES = 65536;
const MAX_WS_BUFFER_BYTES = 4 * 1024 * 1024; // 4MB — drop output if client can't keep up

export class WsBridge {
  private wss: WebSocketServer;
  private clients = new Set<ClientState>();
  private outputBuffers = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(server: Server, private sessions: ISessionManager, private authToken: string) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      // Validate auth token from query parameter
      const token = url.searchParams.get('token');
      if (!token || !safeTokenCompare(token, this.authToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (this.clients.size >= MAX_CLIENTS) {
        ws.close(1013, 'Too many connections');
        return;
      }
      const ip = req.socket.remoteAddress ?? 'unknown';
      const client: ClientState = { ws, subscriptions: new Set(), ip };
      this.clients.add(client);

      // Send current session list
      this.send(ws, { type: 'sessions', sessions: sessions.list() });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsClientMessage;
          this.handleMessage(client, msg);
        } catch {
          this.send(ws, { type: 'error', message: 'Invalid message' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(client);
      });
    });

    // Batch PTY output — coalesce rapid chunks into fewer WS messages (16ms window)
    sessions.on('output', (sessionId: string, data: string) => {
      const cur = this.outputBuffers.get(sessionId) ?? '';
      this.outputBuffers.set(sessionId, cur + data);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flushOutputBuffers(), 16);
      }
    });

    sessions.on('created', (session) => {
      this.broadcast({ type: 'session:created', session });
    });

    sessions.on('exit', (sessionId: string, exitCode: number | null) => {
      this.broadcast({ type: 'session:exited', sessionId, exitCode });
    });

    sessions.on('stateChange', (sessionId: string, detailedState: DetailedState) => {
      this.broadcast({ type: 'session:stateChanged', sessionId, detailedState });
    });
  }

  private handleMessage(client: ClientState, msg: WsClientMessage): void {
    // Validate common fields
    if (!msg || typeof msg.type !== 'string') return;
    if ('sessionId' in msg && typeof msg.sessionId !== 'string') return;

    switch (msg.type) {
      case 'subscribe': {
        if (!msg.sessionId) return;
        // Resize PTY to client dimensions BEFORE sending scrollback.
        if (msg.cols && msg.rows) {
          this.sessions.resize(msg.sessionId, msg.cols, msg.rows);
        }
        client.subscriptions.add(msg.sessionId);
        auditLog({ action: 'ws:subscribe', sessionId: msg.sessionId, source: 'ws', actor: client.ip, result: 'ok' });
        const scrollback = this.sessions.getScrollback(msg.sessionId);
        if (scrollback.length > 0) {
          this.send(client.ws, {
            type: 'scrollback',
            sessionId: msg.sessionId,
            data: scrollback.join(''),
          });
        }
        break;
      }
      case 'unsubscribe':
        if (!msg.sessionId) return;
        client.subscriptions.delete(msg.sessionId);
        break;
      case 'input':
        if (!msg.sessionId || typeof msg.data !== 'string') return;
        if (msg.data.length > MAX_INPUT_BYTES) return;
        this.sessions.write(msg.sessionId, msg.data);
        auditLog({ action: 'ws:input', sessionId: msg.sessionId, source: 'ws', actor: client.ip, summary: `${msg.data.length} bytes`, result: 'ok' });
        break;
      case 'resize':
        if (!msg.sessionId || typeof msg.cols !== 'number' || typeof msg.rows !== 'number') return;
        this.sessions.resize(msg.sessionId, msg.cols, msg.rows);
        auditLog({ action: 'ws:resize', sessionId: msg.sessionId, source: 'ws', actor: client.ip, summary: `${msg.cols}x${msg.rows}`, result: 'ok' });
        break;
    }
  }

  private send(ws: WebSocket, msg: WsServerMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    // Backpressure: drop output/scrollback frames if client can't keep up
    // but always send state updates (session:created, session:exited, etc.)
    if ((msg.type === 'output' || msg.type === 'scrollback') && ws.bufferedAmount > MAX_WS_BUFFER_BYTES) return false;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    return true;
  }

  private broadcast(msg: WsServerMessage): void {
    for (const c of this.clients) {
      this.send(c.ws, msg);
    }
  }

  private flushOutputBuffers(): void {
    this.flushTimer = null;
    for (const [sessionId, data] of this.outputBuffers) {
      for (const c of this.clients) {
        if (c.subscriptions.has(sessionId)) {
          this.send(c.ws, { type: 'output', sessionId, data });
        }
      }
    }
    this.outputBuffers.clear();
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.wss.close();
  }
}
