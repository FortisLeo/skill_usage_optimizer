import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { scanDir, scanSkillRecursive, scanCopilotInstructions, precedenceFromRoot } from './shared.js';

export function discoverCopilot(ctx: DiscoveryContext): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  if (ctx.workspaceRoot) {
    // .github/copilot-instructions.md at workspace root
    try { results.push(...scanCopilotInstructionFile(ctx.workspaceRoot, allowedRoots, ctx)); } catch { /* skip */ }
    // .github/instructions/**/*.instructions.md recursive
    try { results.push(...scanCopilotInstructions(ctx.workspaceRoot, allowedRoots, ctx)); } catch { /* skip */ }

    for (const dir of DEFAULT_SKILL_DIRS.copilot) {
      const root = join(ctx.workspaceRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) {
    try { results.push(...scanCopilotInstructionFile(ctx.repoRoot, allowedRoots, ctx)); } catch { /* skip */ }
    try { results.push(...scanCopilotInstructions(ctx.repoRoot, allowedRoots, ctx)); } catch { /* skip */ }

    for (const dir of DEFAULT_SKILL_DIRS.copilot) {
      const root = join(ctx.repoRoot, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.copilot) {
      const root = join(ctx.homeDir, dir);
      try { results.push(...scanDir(root, allowedRoots, ctx)); } catch { /* skip */ }
      try { results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3)); } catch { /* skip */ }
    }
  }

  return results;
}

function scanCopilotInstructionFile(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext
): DiscoveredArtifact[] {
  const abs = join(baseDir, '.github', 'copilot-instructions.md');
  if (!existsSync(abs)) return [];
  if (!isPathSafe(abs, allowedRoots)) return [];
  try {
    const stat = statSync(abs);
    return [{
      system: 'copilot',
      kind: 'instruction_file',
      absolutePath: abs,
      relativePath: relative(ctx.workspaceRoot || baseDir, abs),
      rootOrigin: baseDir,
      precedence: precedenceFromRoot(baseDir, ctx),
      configIndirection: null,
      rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
    }];
  } catch { return []; }
}
