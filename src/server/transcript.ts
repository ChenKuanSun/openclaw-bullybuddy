import { appendFileSync, mkdirSync } from 'fs';
import type { TranscriptEntry } from './types.js';

const TRANSCRIPT_DIR = process.env.BB_TRANSCRIPT_DIR ?? '';

export function appendTranscriptEntry(sessionId: string, entry: TranscriptEntry): void {
  if (!TRANSCRIPT_DIR) return;
  try {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    appendFileSync(`${TRANSCRIPT_DIR}/${sessionId}.jsonl`, JSON.stringify(entry) + '\n');
  } catch {
    // Silently ignore file write failures
  }
}
