import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  resolveRealpath,
  isWithinRoot,
  isPathSafe,
  collectAllowedRoots,
  validateRoot
} from '../src/fs/roots.js';
import type { DiscoveryContext } from '../src/types.js';

/** Shorthand to build a minimal DiscoveryContext for collectAllowedRoots tests. */
function makeCtx(overrides: Partial<DiscoveryContext>): DiscoveryContext {
  return {
    workspaceRoot: '',
    repoRoot: null,
    homeDir: '',
    includeGlobals: true,
    includeSystem: false,
    explicitRoots: [],
    ...overrides
  };
}

describe('resolveRealpath', () => {
  it('resolves a path to its real path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-test-'));
    try {
      const real = resolveRealpath(tmp);
      expect(real).toBeTruthy();
      expect(real).not.toContain('..');
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('throws for nonexistent paths', () => {
    expect(() => resolveRealpath('/nonexistent/path/xyz')).toThrow();
  });
});

describe('isWithinRoot', () => {
  it('returns true for a child path', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-test-'));
    try {
      const child = join(tmp, 'subdir');
      mkdirSync(child);
      expect(isWithinRoot(child, tmp)).toBe(true);
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('returns false for paths outside the root', () => {
    const tmp1 = mkdtempSync(join(tmpdir(), 'roots-test1-'));
    const tmp2 = mkdtempSync(join(tmpdir(), 'roots-test2-'));
    try {
      expect(isWithinRoot(tmp2, tmp1)).toBe(false);
    } finally {
      try { rmSync(tmp1, { recursive: true }); } catch { /* ok */ }
      try { rmSync(tmp2, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('rejects traversal via symlink escape', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-test-'));
    try {
      // Create a symlink inside root pointing outside
      const outside = mkdtempSync(join(tmpdir(), 'roots-outside-'));
      const linkPath = join(tmp, 'escape-link');
      symlinkSync(outside, linkPath);
      // isWithinRoot resolves realpath, so the symlink to outside should fail
      expect(isWithinRoot(linkPath, tmp)).toBe(false);
      try { rmSync(outside, { recursive: true }); } catch { /* ok */ }
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe('isPathSafe', () => {
  it('returns true when path is within allowed roots', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-safe-'));
    try {
      expect(isPathSafe(tmp, [tmp])).toBe(true);
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('returns false when path is outside all allowed roots', () => {
    const tmp1 = mkdtempSync(join(tmpdir(), 'roots-safe1-'));
    const tmp2 = mkdtempSync(join(tmpdir(), 'roots-safe2-'));
    try {
      expect(isPathSafe(tmp2, [tmp1])).toBe(false);
    } finally {
      try { rmSync(tmp1, { recursive: true }); } catch { /* ok */ }
      try { rmSync(tmp2, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe('collectAllowedRoots', () => {
  it('collects workspace and home roots when includeGlobals is true', () => {
    const ws = mkdtempSync(join(tmpdir(), 'roots-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'roots-home-'));
    try {
      const roots = collectAllowedRoots(makeCtx({ workspaceRoot: ws, homeDir: home }));
      expect(roots.length).toBeGreaterThanOrEqual(2);
    } finally {
      try { rmSync(ws, { recursive: true }); } catch { /* ok */ }
      try { rmSync(home, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('excludes homeDir when includeGlobals is false', () => {
    const ws = mkdtempSync(join(tmpdir(), 'roots-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'roots-home-'));
    try {
      const roots = collectAllowedRoots(makeCtx({ workspaceRoot: ws, homeDir: home, includeGlobals: false }));
      const realHome = resolveRealpath(home);
      expect(roots.every(r => !isWithinRoot(r, realHome))).toBe(true);
    } finally {
      try { rmSync(ws, { recursive: true }); } catch { /* ok */ }
      try { rmSync(home, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('includes explicit roots', () => {
    const ws = mkdtempSync(join(tmpdir(), 'roots-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'roots-home-'));
    const explicit = mkdtempSync(join(tmpdir(), 'roots-explicit-'));
    try {
      const roots = collectAllowedRoots(makeCtx({ workspaceRoot: ws, homeDir: home, explicitRoots: [explicit] }));
      expect(roots.some(r => r === resolveRealpath(explicit))).toBe(true);
    } finally {
      try { rmSync(ws, { recursive: true }); } catch { /* ok */ }
      try { rmSync(home, { recursive: true }); } catch { /* ok */ }
      try { rmSync(explicit, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('includes codex system root when includeSystem is true and codexSystemRoot exists', () => {
    const ws = mkdtempSync(join(tmpdir(), 'roots-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'roots-home-'));
    const sysRoot = mkdtempSync(join(tmpdir(), 'roots-system-'));
    try {
      const roots = collectAllowedRoots(makeCtx({
        workspaceRoot: ws,
        homeDir: home,
        includeGlobals: false,
        includeSystem: true,
        codexSystemRoot: sysRoot
      }));
      expect(roots.some(r => r === resolveRealpath(sysRoot))).toBe(true);
    } finally {
      try { rmSync(ws, { recursive: true }); } catch { /* ok */ }
      try { rmSync(home, { recursive: true }); } catch { /* ok */ }
      try { rmSync(sysRoot, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('excludes codex system root when includeSystem is false', () => {
    const ws = mkdtempSync(join(tmpdir(), 'roots-ws-'));
    const home = mkdtempSync(join(tmpdir(), 'roots-home-'));
    const sysRoot = mkdtempSync(join(tmpdir(), 'roots-system-'));
    try {
      const roots = collectAllowedRoots(makeCtx({
        workspaceRoot: ws,
        homeDir: home,
        includeGlobals: false,
        includeSystem: false,
        codexSystemRoot: sysRoot
      }));
      expect(roots.some(r => r === resolveRealpath(sysRoot))).toBe(false);
    } finally {
      try { rmSync(ws, { recursive: true }); } catch { /* ok */ }
      try { rmSync(home, { recursive: true }); } catch { /* ok */ }
      try { rmSync(sysRoot, { recursive: true }); } catch { /* ok */ }
    }
  });
});

describe('validateRoot', () => {
  it('returns realpath for a valid directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-validate-'));
    try {
      const resolved = validateRoot(tmp);
      expect(resolved).toBeTruthy();
      expect(resolved).toBe(resolveRealpath(tmp));
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });

  it('throws for nonexistent root', () => {
    expect(() => validateRoot('/nonexistent')).toThrow();
  });

  it('throws when root is a file, not a directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'roots-validate-'));
    const filePath = join(tmp, 'test.txt');
    writeFileSync(filePath, 'hello');
    try {
      expect(() => validateRoot(filePath)).toThrow('not a directory');
    } finally {
      try { rmSync(tmp, { recursive: true }); } catch { /* ok */ }
    }
  });
});
