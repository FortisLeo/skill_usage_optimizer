import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { scanDir, scanSkillRecursive, scanRootInstructionFiles } from './shared.js';

export function discoverClaude(ctx: DiscoveryContext): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  // Workspace-level
  if (ctx.workspaceRoot) {
    // Root instruction files: AGENTS.md, CLAUDE.md
    try { results.push(...scanRootInstructionFiles(ctx.workspaceRoot, allowedRoots, ctx)); } catch { /* skip */ }

    for (const dir of DEFAULT_SKILL_DIRS.claude) {
      const root = join(ctx.workspaceRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      // Recursive SKILL.md beyond one nested dir
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  // Repo-level
  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) {
    try { results.push(...scanRootInstructionFiles(ctx.repoRoot, allowedRoots, ctx)); } catch { /* skip */ }

    for (const dir of DEFAULT_SKILL_DIRS.claude) {
      const root = join(ctx.repoRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  // Global
  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.claude) {
      const root = join(ctx.homeDir, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  return results;
}
