import { dirname, join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';

export type OpenCodeDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverOpencode(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: OpenCodeDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  const scanProject = (baseDir: string): void => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const found = scanFile(join(baseDir, name), baseDir, allowedRoots, ctx, 'opencode', 'instruction_file', baseDir, onScan, budget);
      if (found.length > 0) { results.push(...found); break; }
    }
    for (const dir of DEFAULT_SKILL_DIRS.opencode) {
      results.push(...scanSourceRoot(join(baseDir, dir), allowedRoots, ctx, 'opencode', 3, onScan, scannerLimits, budget));
    }
  };

  if (ctx.workspaceRoot) scanProject(ctx.workspaceRoot);
  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) scanProject(ctx.repoRoot);

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.opencode) {
      results.push(...scanSourceRoot(join(ctx.homeDir, dir), allowedRoots, ctx, 'opencode', 3, onScan, scannerLimits, budget));
    }
    for (const instruction of [
      join(ctx.homeDir, '.config', 'opencode', 'AGENTS.md'),
      join(ctx.homeDir, '.claude', 'CLAUDE.md')
    ]) {
      const found = scanFile(instruction, dirname(instruction), allowedRoots, ctx, 'opencode', 'instruction_file', dirname(instruction), onScan, budget);
      if (found.length > 0) { results.push(...found); break; }
    }
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'opencode',
    capability: 'roots',
    sourceType: 'roots',
    status: 'unavailable',
    code: 'SOURCE_ABSENT',
    foundCount: 0,
    skippedCount: 0,
    limitation: 'No supported OpenCode documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'opencode',
    capability: 'runtime_bridge',
    sourceType: 'runtime',
    status: 'unavailable',
    code: 'SOURCE_UNSUPPORTED',
    foundCount: 0,
    skippedCount: 0,
    limitation: 'Runtime-effective plugin paths are unavailable; only documented roots are scanned.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}
