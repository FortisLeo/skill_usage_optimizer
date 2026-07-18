import { existsSync, lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { CODEX_SYSTEM_SKILLS_DIR } from '../config.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, projectChain, reportBudgetExhaustion, scanFile, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';

export type CodexDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverCodex(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: CodexDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  for (const dir of projectChain(ctx)) {
    results.push(...scanInstruction(dir, allowedRoots, ctx, onScan, budget));
    results.push(...scanSourceRoot(join(dir, '.agents', 'skills'), allowedRoots, ctx, 'codex', 3, onScan, scannerLimits, budget));
    results.push(...scanAgents(join(dir, '.codex', 'agents'), allowedRoots, ctx, onScan, budget));
  }

  if (ctx.includeGlobals) {
    const codexHome = join(ctx.homeDir, '.codex');
    results.push(...scanInstruction(codexHome, allowedRoots, ctx, onScan, budget));
    results.push(...scanSourceRoot(join(ctx.homeDir, '.agents', 'skills'), allowedRoots, ctx, 'codex', 3, onScan, scannerLimits, budget));
    results.push(...scanAgents(join(codexHome, 'agents'), allowedRoots, ctx, onScan, budget));
  }

  if (ctx.includeSystem) {
    results.push(...scanSourceRoot(ctx.codexSystemRoot ?? CODEX_SYSTEM_SKILLS_DIR, allowedRoots, ctx, 'codex', 3, onScan, scannerLimits, budget));
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'codex', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported Codex CLI documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'codex', capability: 'configuration', sourceType: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED',
    foundCount: 0, skippedCount: 0,
    limitation: 'Configured fallback names, alternate CODEX_HOME, bundled skills, plugins, and runtime-effective sources are not resolved.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}

function scanInstruction(
  dir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  if (budget.exhausted) return [];
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const stat = lstatSync(file);
      if (!stat.isSymbolicLink() && stat.size === 0) continue;
    } catch { /* scanner reports it */ }
    return scanFile(file, dir, allowedRoots, ctx, 'codex', 'instruction_file', dir, onScan, budget);
  }
  return [];
}

function scanAgents(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  if (budget.exhausted || !existsSync(root)) return [];
  if (Buffer.byteLength(root, 'utf8') > budget.limits.pathBytes) {
    onScan?.({ root, system: 'codex', foundCount: 0, skippedCount: 1, truncated: false, reasons: ['path_length'] });
    return [];
  }
  const results: DiscoveredArtifact[] = [];
  let skipped = 0;
  try {
    if (lstatSync(root).isSymbolicLink()) {
      onScan?.({ root, system: 'codex', foundCount: 0, skippedCount: 1, truncated: false, reasons: ['symlink'] });
      return [];
    }
    const dir = opendirSync(root);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (!budget.visit()) {
          reportBudgetExhaustion(budget, root, 'codex', onScan, results.length);
          return results;
        }
        if (entry.isSymbolicLink()) { skipped++; continue; }
        if (entry.isFile() && entry.name.endsWith('.toml')) {
          results.push(...scanFile(join(root, entry.name), root, allowedRoots, ctx, 'codex', 'instruction_file', root, onScan, budget));
          if (budget.exhausted) return results;
        }
      }
    } finally { dir.closeSync(); }
  } catch {
    onScan?.({ root, system: 'codex', foundCount: 0, skippedCount: skipped + 1, truncated: false, reasons: ['inaccessible'] });
  }
  if (skipped > 0) onScan?.({ root, system: 'codex', foundCount: 0, skippedCount: skipped, truncated: false, reasons: ['symlink'] });
  return results;
}
