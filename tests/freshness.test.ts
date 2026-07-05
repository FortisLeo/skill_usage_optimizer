import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { computeHash, fileHash, statFile, isStale } from '../src/fs/freshness.js';

describe('computeHash', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeHash('hello world');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('produces different hashes for different content', () => {
    const h1 = computeHash('a');
    const h2 = computeHash('b');
    expect(h1).not.toBe(h2);
  });

  it('produces the same hash for identical content', () => {
    const h1 = computeHash('same');
    const h2 = computeHash('same');
    expect(h1).toBe(h2);
  });
});

describe('fileHash', () => {
  it('hashes file content on disk', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'freshness-'));
    const path = join(tmp, 'test.txt');
    writeFileSync(path, 'file content');
    try {
      const hash = fileHash(path);
      expect(hash).toBe(computeHash('file content'));
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe('statFile', () => {
  it('returns mtimeMs and size for existing files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'freshness-'));
    const path = join(tmp, 'test.txt');
    writeFileSync(path, 'hello');
    try {
      const stat = statFile(path);
      expect(stat).not.toBeNull();
      expect(stat!.size).toBe(5);
      expect(typeof stat!.mtimeMs).toBe('number');
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('returns null for nonexistent paths', () => {
    expect(statFile('/nonexistent/file.txt')).toBeNull();
  });
});

describe('isStale', () => {
  it('returns true when hashes differ', () => {
    const stored = { hash: 'aaa', mtimeMs: 100, size: 1 };
    const current = { hash: 'bbb', mtimeMs: 100, size: 1 };
    expect(isStale(stored, current)).toBe(true);
  });

  it('returns true when mtime is newer', () => {
    const stored = { hash: 'aaa', mtimeMs: 100, size: 1 };
    const current = { hash: 'aaa', mtimeMs: 200, size: 1 };
    expect(isStale(stored, current)).toBe(true);
  });

  it('returns true when mtime is older', () => {
    const stored = { hash: 'aaa', mtimeMs: 200, size: 1 };
    const current = { hash: 'aaa', mtimeMs: 100, size: 1 };
    expect(isStale(stored, current)).toBe(true);
  });

  it('returns true when size differs', () => {
    const stored = { hash: 'aaa', mtimeMs: 100, size: 1 };
    const current = { hash: 'aaa', mtimeMs: 100, size: 2 };
    expect(isStale(stored, current)).toBe(true);
  });

  it('returns false when hash, mtime, and size match', () => {
    const stored = { hash: 'aaa', mtimeMs: 100, size: 1 };
    const current = { hash: 'aaa', mtimeMs: 100, size: 1 };
    expect(isStale(stored, current)).toBe(false);
  });
});
