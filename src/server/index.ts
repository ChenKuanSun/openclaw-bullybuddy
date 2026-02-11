import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { SessionManager } from './session-manager.js';
import { WsBridge } from './ws-bridge.js';
import { createApiHandler } from './api.js';
import { setupWebhook } from './webhook.js';

const PORT = parseInt(process.env.BB_PORT ?? '18900', 10);
const HOST = process.env.BB_HOST ?? '127.0.0.1';
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
server.listen(PORT, HOST, () => {
  console.log(`[bb] server listening on http://${HOST}:${PORT}`);
  console.log(`[bb] token:     ${masked}`);
  console.log(`[bb] dashboard: http://${HOST}:${PORT}/?token=${AUTH_TOKEN}`);
});

// Graceful shutdown (guard against duplicate signals)
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[bb] shutting down...');
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
