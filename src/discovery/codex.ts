import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS, CODEX_SYSTEM_SKILLS_DIR } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { scanDir, scanSkillRecursive } from './shared.js';

export function discoverCodex(ctx: DiscoveryContext): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  if (ctx.workspaceRoot) {
    for (const dir of DEFAULT_SKILL_DIRS.codex) {
      const root = join(ctx.workspaceRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) {
    for (const dir of DEFAULT_SKILL_DIRS.codex) {
      const root = join(ctx.repoRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.codex) {
      const root = join(ctx.homeDir, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  // System-level discovery (/etc/codex/skills) — gated by includeSystem.
  // collectAllowedRoots already includes codexSystemRoot when includeSystem is true.
  if (ctx.includeSystem) {
    const systemRoot = ctx.codexSystemRoot ?? CODEX_SYSTEM_SKILLS_DIR;
    try { results.push(...scanDir(systemRoot, allowedRoots, ctx)); } catch { /* skip */ }
    try { results.push(...scanSkillRecursive(systemRoot, allowedRoots, ctx, systemRoot, 3)); } catch { /* skip */ }
  }

  return results;
}
