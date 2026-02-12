import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { api, wsUrl } from './client.js';
import type { SessionInfo, GroupInfo } from '../server/types.js';

const CONN_FILE = join(homedir(), '.bullybuddy', 'connection.json');

const program = new Command();

program
  .name('bullybuddy')
  .description('BullyBuddy — Claude Code session manager')
  .version('0.1.0');

// ── server ───────────────────────────────────────────────────────────────────

program
  .command('server')
  .description('Start the BullyBuddy server')
  .option('--tunnel', 'Start Cloudflare tunnel for remote access')
  .action(async (opts) => {
    if (opts.tunnel) process.env.BB_TUNNEL = 'true';
    await import('../server/index.js');
  });

// ── spawn ────────────────────────────────────────────────────────────────────

program
  .command('spawn')
  .description('Spawn a new Claude Code session')
  .option('-n, --name <name>', 'Session name')
  .option('-g, --group <group>', 'Group name', 'default')
  .option('-c, --cwd <dir>', 'Working directory', process.cwd())
  .option('--cols <n>', 'Terminal columns', '120')
  .option('--rows <n>', 'Terminal rows', '40')
  .argument('[args...]', 'Extra arguments to pass to claude')
  .action(async (args: string[], opts) => {
    const res = await api<SessionInfo>('/api/sessions', 'POST', {
      name: opts.name,
      group: opts.group,
      cwd: opts.cwd,
      args,
      cols: parseInt(opts.cols, 10),
      rows: parseInt(opts.rows, 10),
    });
    if (!res.ok) {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    const s = res.data!;
    console.log(`Spawned session ${s.id} (${s.name}) in group "${s.group}"`);
    console.log(`  PID: ${s.pid}  CWD: ${s.cwd}`);
  });

// ── list ─────────────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('List sessions')
  .option('-g, --group <group>', 'Filter by group')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const query = opts.group ? `?group=${encodeURIComponent(opts.group)}` : '';
    const res = await api<SessionInfo[]>(`/api/sessions${query}`);
    if (!res.ok) {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    const sessions = res.data!;
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log('No sessions.');
      return;
    }
    console.log(
      'ID        NAME                  GROUP       STATUS   PID      CWD',
    );
    console.log('─'.repeat(80));
    for (const s of sessions) {
      const status = s.status === 'running' ? '●' : '○';
      console.log(
        `${s.id.padEnd(10)}${s.name.padEnd(22)}${s.group.padEnd(12)}${status} ${(s.status).padEnd(9)}${String(s.pid ?? '-').padEnd(9)}${s.cwd}`,
      );
    }
  });

// ── send ─────────────────────────────────────────────────────────────────────

program
  .command('send')
  .description('Send input to a session')
  .argument('<id>', 'Session ID')
  .argument('<text>', 'Text to send (appends carriage return)')
  .action(async (id: string, text: string) => {
    const res = await api(`/api/sessions/${id}/input`, 'POST', {
      data: text + '\r',
    });
    if (!res.ok) {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    console.log(`Sent to ${id}.`);
  });

// ── kill ─────────────────────────────────────────────────────────────────────

program
  .command('kill')
  .description('Kill a session')
  .argument('<id>', 'Session ID')
  .action(async (id: string) => {
    const res = await api(`/api/sessions/${id}`, 'DELETE');
    if (!res.ok) {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    console.log(`Killed ${id}.`);
  });

// ── attach ───────────────────────────────────────────────────────────────────

program
  .command('attach')
  .description('Attach to a session (interactive)')
  .argument('<id>', 'Session ID')
  .action(async (id: string) => {
    // Verify session exists
    const check = await api<SessionInfo>(`/api/sessions/${id}`);
    if (!check.ok) {
      console.error(`Error: ${check.error}`);
      process.exit(1);
    }

    const { WebSocket } = await import('ws');
    const ws = new WebSocket(wsUrl());

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', sessionId: id }));

      // Send terminal size on connect
      if (process.stdout.columns && process.stdout.rows) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            sessionId: id,
            cols: process.stdout.columns,
            rows: process.stdout.rows,
          }),
        );
      }

      // Enter raw mode for interactive terminal
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on('data', (data: Buffer) => {
        // Ctrl+] to detach
        if (data[0] === 0x1d) {
          console.log('\nDetached.');
          ws.close();
          process.exit(0);
        }
        ws.send(JSON.stringify({ type: 'input', sessionId: id, data: data.toString() }));
      });
    });

    // Track terminal resizes
    if (process.stdout.columns && process.stdout.rows) {
      process.stdout.on('resize', () => {
        ws.send(
          JSON.stringify({
            type: 'resize',
            sessionId: id,
            cols: process.stdout.columns,
            rows: process.stdout.rows,
          }),
        );
      });
    }

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'output' && msg.sessionId === id) {
        process.stdout.write(msg.data);
      }
      if (msg.type === 'session:exited' && msg.sessionId === id) {
        console.log(`\nSession exited (code: ${msg.exitCode}).`);
        ws.close();
        process.exit(msg.exitCode ?? 0);
      }
    });

    ws.on('close', () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
      process.exit(1);
    });
  });

// ── groups ───────────────────────────────────────────────────────────────────

program
  .command('groups')
  .description('List session groups')
  .action(async () => {
    const res = await api<GroupInfo[]>('/api/groups');
    if (!res.ok) {
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    const groups = res.data!;
    if (groups.length === 0) {
      console.log('No groups.');
      return;
    }
    for (const g of groups) {
      console.log(`${g.name} (${g.sessionCount} sessions)`);
      for (const s of g.sessions) {
        const status = s.status === 'running' ? '●' : '○';
        console.log(`  ${status} ${s.id}  ${s.name}`);
      }
    }
  });

// ── open ─────────────────────────────────────────────────────────────────────

program
  .command('open')
  .description('Open the web dashboard in browser')
  .action(async () => {
    let url = '';
    if (existsSync(CONN_FILE)) {
      try {
        const conn = JSON.parse(readFileSync(CONN_FILE, 'utf-8'));
        url = `${conn.url}/?token=${conn.token}`;
      } catch { /* fall through */ }
    }
    if (!url) {
      const host = process.env.BB_HOST ?? '127.0.0.1';
      const port = process.env.BB_PORT ?? '18900';
      url = `http://${host}:${port}`;
    }
    const open = (await import('open')).default;
    await open(url);
    console.log(`Opened ${url}`);
  });

// ── url ─────────────────────────────────────────────────────────────────────

program
  .command('url')
  .description('Show dashboard URL (local and tunnel if active)')
  .action(async () => {
    if (!existsSync(CONN_FILE)) {
      console.error('Server not running (no connection file found).');
      process.exit(1);
    }
    try {
      const conn = JSON.parse(readFileSync(CONN_FILE, 'utf-8'));
      console.log(`Local:  ${conn.url}/?token=${conn.token}`);
      if (conn.tunnel) {
        console.log(`Tunnel: ${conn.tunnel}/?token=${conn.token}`);
      }
    } catch {
      console.error('Could not read connection file.');
      process.exit(1);
    }
  });

program.parse();
