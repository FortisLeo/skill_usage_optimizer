import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scanMarkdownRoot, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';

export type CursorDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverCursor(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: CursorDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  for (const baseDir of [ctx.repoRoot, ctx.workspaceRoot].filter((dir, index, dirs): dir is string => Boolean(dir) && dirs.indexOf(dir) === index)) {
    for (const dir of DEFAULT_SKILL_DIRS.cursor) {
      results.push(...scanSourceRoot(join(baseDir, dir), allowedRoots, ctx, 'cursor', 3, onScan, scannerLimits, budget));
    }
    results.push(...scanMarkdownRoot(join(baseDir, '.cursor', 'rules'), allowedRoots, ctx, 'cursor', '.mdc', 'rule_file', 4, onScan, budget));
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      results.push(...scanFile(join(baseDir, name), baseDir, allowedRoots, ctx, 'cursor', 'instruction_file', baseDir, onScan, budget));
    }
    results.push(...scanFile(join(baseDir, '.cursorrules'), baseDir, allowedRoots, ctx, 'cursor', 'rule_file', baseDir, onScan, budget));
  }

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.cursor) {
      results.push(...scanSourceRoot(join(ctx.homeDir, dir), allowedRoots, ctx, 'cursor', 3, onScan, scannerLimits, budget));
    }
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'cursor', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported Cursor documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'cursor', capability: 'configuration', sourceType: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED',
    foundCount: 0, skippedCount: 0,
    limitation: 'User and team rules, commands, enabled state, and runtime-effective context have no stable readable discovery contract.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}
