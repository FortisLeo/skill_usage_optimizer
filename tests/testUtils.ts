import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { DiscoveryContext } from '../src/types.js';

export function makeTempWorkspace(): { root: string; ctx: DiscoveryContext; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'skill-opt-test-'));
  // Create typical source-system directory structure
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(root, '.opencode', 'skills'), { recursive: true });
  mkdirSync(join(root, '.codex', 'skills'), { recursive: true });
  mkdirSync(join(root, '.github', 'copilot'), { recursive: true });

  const homeDir = mkdtempSync(join(tmpdir(), 'skill-opt-home-'));
  mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(homeDir, '.opencode', 'skills'), { recursive: true });
  mkdirSync(join(homeDir, '.config', 'opencode', 'skills'), { recursive: true });

  const ctx: DiscoveryContext = {
    workspaceRoot: root,
    repoRoot: null,
    homeDir,
    includeGlobals: true,
    includeSystem: false,
    explicitRoots: []
  };

  const cleanup = () => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ok */ }
  };

  return { root, ctx, cleanup };
}

export function writeFixture(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}
