import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import { SessionManager } from './session-manager.js';
import { WsBridge } from './ws-bridge.js';
import { createApiHandler } from './api.js';
import { setupWebhook } from './webhook.js';

const PORT = parseInt(process.env.BB_PORT ?? '18900', 10);
const HOST = process.env.BB_HOST ?? '127.0.0.1';

const BB_DIR = join(homedir(), '.bullybuddy');
const CONN_FILE = join(BB_DIR, 'connection.json');

const AUTH_TOKEN = process.env.BB_TOKEN || randomBytes(16).toString('hex');

if (AUTH_TOKEN.length < 8) {
  console.error('[bb] ERROR: auth token must be at least 8 characters. Aborting.');
  process.exit(1);
}

const sessions = new SessionManager();
setupWebhook(sessions);
const server = createServer(createApiHandler(sessions, AUTH_TOKEN));
const wsBridge = new WsBridge(server, sessions, AUTH_TOKEN);

const masked = AUTH_TOKEN.slice(0, 4) + '...' + AUTH_TOKEN.slice(-4);

// Use 127.0.0.1 for local clients when server binds to all interfaces
const connHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
try { mkdirSync(BB_DIR, { recursive: true }); } catch { /* ignore */ }

let tunnelProcess: ChildProcess | null = null;

function writeConnFile(extra?: Record<string, string>) {
  try {
    const data: Record<string, string> = { url: `http://${connHost}:${PORT}`, token: AUTH_TOKEN };
    if (extra) Object.assign(data, extra);
    writeFileSync(CONN_FILE, JSON.stringify(data), { mode: 0o600 });
  } catch {
    console.error('[bb] warning: could not write connection file');
  }
}

server.listen(PORT, HOST, () => {
  writeConnFile();
  console.log(`[bb] server listening on http://${HOST}:${PORT}`);
  console.log(`[bb] token:     ${masked}`);
  console.log(`[bb] dashboard: http://${HOST}:${PORT}/?token=${AUTH_TOKEN}`);

  // Start Cloudflare tunnel if requested
  if (process.env.BB_TUNNEL === 'true') {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tunnelFound = false;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelFound) {
        tunnelFound = true;
        console.log(`[bb] tunnel:    ${match[0]}`);
        console.log(`[bb] remote:    ${match[0]}/?token=${AUTH_TOKEN}`);
        writeConnFile({ tunnel: match[0] });
      }
    };
    tunnelProcess.stdout!.on('data', onData);
    tunnelProcess.stderr!.on('data', onData);
    tunnelProcess.on('error', () => {
      console.error('[bb] warning: cloudflared not found — install with: brew install cloudflared');
    });
    tunnelProcess.on('exit', (code) => {
      if (!shuttingDown) console.log(`[bb] cloudflared exited (code: ${code})`);
    });
  }
});

// Graceful shutdown (guard against duplicate signals)
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[bb] shutting down...');
  if (tunnelProcess) tunnelProcess.kill();
  try { unlinkSync(CONN_FILE); } catch { /* ignore */ }
  sessions.killAll();
  wsBridge.close();
  const forceTimer = setTimeout(() => {
    console.log('[bb] force exit (timeout)');
    process.exit(1);
  }, 3000);
  forceTimer.unref();
  server.close(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
