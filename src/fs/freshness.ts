import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function fileHash(path: string): string {
  return computeHash(readFileSync(path, 'utf-8'));
}

export function statFile(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

export interface FreshnessEntry {
  hash: string;
  mtimeMs: number;
  size: number;
}

// ponytail: normalize line-endings + strip BOM, used by normalize + freshness checks
export function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isStale(stored: FreshnessEntry, current: FreshnessEntry): boolean {
  if (stored.hash !== current.hash) return true;
  if (stored.mtimeMs !== current.mtimeMs) return true;
  return stored.size !== current.size;
}
