import type { ApiResponse } from '../server/types.js';

const BASE = `http://${process.env.BB_HOST ?? '127.0.0.1'}:${process.env.BB_PORT ?? '18900'}`;
const TOKEN = process.env.BB_TOKEN ?? '';

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
  const host = process.env.BB_HOST ?? '127.0.0.1';
  const port = process.env.BB_PORT ?? '18900';
  const tokenParam = TOKEN ? `?token=${TOKEN}` : '';
  return `ws://${host}:${port}/ws${tokenParam}`;
}
