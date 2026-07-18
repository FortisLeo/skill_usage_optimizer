import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scanSourceRoot, scanCopilotInstructions, scanMarkdownRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';

export type CopilotDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverCopilot(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: CopilotDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  if (ctx.workspaceRoot) {
    scanProject(ctx.workspaceRoot, allowedRoots, ctx, results, onScan, budget);
  }

  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) {
    scanProject(ctx.repoRoot, allowedRoots, ctx, results, onScan, budget);
  }

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.copilot) {
      const root = join(ctx.homeDir, dir);
      try { results.push(...scanSourceRoot(root, allowedRoots, ctx, 'copilot', 3, onScan, scannerLimits, budget)); } catch { /* skip */ }
    }
    for (const [dir, suffix, kind] of [
      ['.copilot/instructions', '.instructions.md', 'instruction_file'],
      ['.claude/rules', '.md', 'rule_file'],
      ['.copilot/agents', '.agent.md', 'instruction_file']
    ] as const) {
      const depth = dir.endsWith('/agents') ? 0 : 4;
      try { results.push(...scanMarkdownRoot(join(ctx.homeDir, dir), allowedRoots, ctx, 'copilot', suffix, kind, depth, onScan, budget)); } catch { /* skip */ }
    }
    try { results.push(...scanFile(join(ctx.homeDir, '.claude', 'CLAUDE.md'), join(ctx.homeDir, '.claude'), allowedRoots, ctx, 'copilot', 'instruction_file', join(ctx.homeDir, '.claude'), onScan, budget)); } catch { /* skip */ }
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'copilot', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported GitHub Copilot or VS Code documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'copilot', capability: 'configuration', sourceType: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED',
    foundCount: 0, skippedCount: 0,
    limitation: 'Runtime-applied diagnostics, profile user data, configured extra locations, and organization sources have no stable readable API.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}

function scanProject(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  results: DiscoveredArtifact[],
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): void {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
    try { results.push(...scanFile(join(baseDir, name), baseDir, allowedRoots, ctx, 'copilot', 'instruction_file', baseDir, onScan, budget)); } catch { /* skip */ }
  }
  try { results.push(...scanCopilotInstructionFile(baseDir, allowedRoots, ctx, onScan, budget)); } catch { /* skip */ }
  try { results.push(...scanCopilotInstructions(baseDir, allowedRoots, ctx, 'copilot', 4, onScan, budget)); } catch { /* skip */ }
  for (const dir of DEFAULT_SKILL_DIRS.copilot) {
    try { results.push(...scanSourceRoot(join(baseDir, dir), allowedRoots, ctx, 'copilot', 3, onScan, scannerLimits, budget)); } catch { /* skip */ }
  }
  for (const [dir, suffix, kind] of [
    ['.claude/rules', '.md', 'rule_file'],
    ['.github/prompts', '.prompt.md', 'instruction_file'],
    ['.github/agents', '.md', 'instruction_file'],
    ['.claude/agents', '.md', 'instruction_file']
  ] as const) {
    const depth = dir.endsWith('/rules') ? 4 : 0;
    try { results.push(...scanMarkdownRoot(join(baseDir, dir), allowedRoots, ctx, 'copilot', suffix, kind, depth, onScan, budget)); } catch { /* skip */ }
  }
}

function scanCopilotInstructionFile(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  const abs = join(baseDir, '.github', 'copilot-instructions.md');
  return scanFile(abs, baseDir, allowedRoots, ctx, 'copilot', 'instruction_file', baseDir, onScan, budget);
}
