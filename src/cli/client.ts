import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ApiResponse } from '../server/types.js';

const CONN_FILE = join(homedir(), '.bullybuddy', 'connection.json');

let BASE = `http://${process.env.BB_HOST ?? '127.0.0.1'}:${process.env.BB_PORT ?? '18900'}`;
let TOKEN = process.env.BB_TOKEN ?? '';

// Auto-discover from connection.json if no env vars set
if (!TOKEN && existsSync(CONN_FILE)) {
  try {
    const conn = JSON.parse(readFileSync(CONN_FILE, 'utf-8'));
    if (conn.url) BASE = conn.url;
    if (conn.token) TOKEN = conn.token;
  } catch { /* ignore */ }
}

export async function api<T = unknown>(
  path: string,
  method: string = 'GET',
  body?: unknown,
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as ApiResponse<T>;
}

export function wsUrl(): string {
  const url = new URL(BASE);
  const tokenParam = TOKEN ? `?token=${TOKEN}` : '';
  return `ws://${url.host}/ws${tokenParam}`;
}
