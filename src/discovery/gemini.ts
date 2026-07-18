import { existsSync, lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { DEFAULT_SKILL_DIRS, GLOBAL_SKILL_DIRS, PRECEDENCE } from '../config.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, projectChain, reportBudgetExhaustion, scanFile, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';
const EXTENSION_PRECEDENCE = 20;
type ExtensionSkipReason = 'entry_limit' | 'result_limit' | 'path_length' | 'symlink' | 'unsafe' | 'inaccessible';

export type GeminiDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverGemini(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: GeminiDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  for (const dir of projectChain(ctx)) {
    for (const skillDir of DEFAULT_SKILL_DIRS.gemini) {
      const artifacts = scanSourceRoot(join(dir, skillDir), allowedRoots, ctx, 'gemini', 3, onScan, scannerLimits, budget);
      results.push(...(skillDir === '.agents/skills' ? withPrecedence(artifacts, artifact => artifact.precedence + 1) : artifacts));
    }
    results.push(...scanFile(join(dir, 'GEMINI.md'), dir, allowedRoots, ctx, 'gemini', 'instruction_file', dir, onScan, budget));
  }

  if (ctx.includeGlobals) {
    for (const skillDir of GLOBAL_SKILL_DIRS.gemini) {
      const artifacts = scanSourceRoot(join(ctx.homeDir, skillDir), allowedRoots, ctx, 'gemini', 3, onScan, scannerLimits, budget);
      results.push(...(skillDir === '.agents/skills' ? withPrecedence(artifacts, () => PRECEDENCE.global + 1) : artifacts));
    }
    results.push(...scanFile(join(ctx.homeDir, '.gemini', 'GEMINI.md'), join(ctx.homeDir, '.gemini'), allowedRoots, ctx, 'gemini', 'instruction_file', join(ctx.homeDir, '.gemini'), onScan, budget));
    results.push(...scanExtensionSkills(ctx, allowedRoots, onScan, budget));
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'gemini', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported Gemini CLI documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'gemini', capability: 'configuration', sourceType: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED',
    foundCount: 0, skippedCount: 0,
    limitation: 'Runtime skill lists, disabled state, linked sources, and JIT context have no stable machine-readable discovery contract.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}

function scanExtensionSkills(ctx: DiscoveryContext, allowedRoots: string[], onScan: ScanSafetyCallback | undefined, budget: ScanBudget): DiscoveredArtifact[] {
  const root = join(ctx.homeDir, '.gemini', 'extensions');
  if (budget.exhausted || !existsSync(root)) return [];
  const results: DiscoveredArtifact[] = [];
  let skipped = 0;
  let truncated = false;
  const reasons = new Set<ExtensionSkipReason>();
  const mark = (reason: ExtensionSkipReason, stop = false): void => {
    skipped++;
    reasons.add(reason);
    truncated ||= stop;
  };
  try {
    if (Buffer.byteLength(root, 'utf8') > budget.limits.pathBytes) mark('path_length');
    else if (lstatSync(root).isSymbolicLink()) mark('symlink');
    else if (!isPathSafe(root, allowedRoots)) mark('unsafe');
    else {
      const dir = opendirSync(root);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (!budget.visit()) { mark('entry_limit', true); break; }
          if (entry.isSymbolicLink()) { mark('symlink'); continue; }
          if (!entry.isDirectory()) continue;
          const extensionRoot = join(root, entry.name);
          const manifest = join(extensionRoot, 'gemini-extension.json');
          try {
            if (!existsSync(manifest)) continue;
            const stat = lstatSync(manifest);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
          } catch { mark('inaccessible'); continue; }
          const artifacts = withPrecedence(scanSourceRoot(join(extensionRoot, 'skills'), allowedRoots, ctx, 'gemini', 3, onScan, scannerLimits, budget), () => EXTENSION_PRECEDENCE);
          results.push(...artifacts);
          if (budget.exhausted) break;
        }
      } finally { dir.closeSync(); }
    }
  } catch { mark('inaccessible'); }
  if (truncated && budget.exhausted) reportBudgetExhaustion(budget, root, 'gemini', onScan);
  else if (skipped > 0) onScan?.({ root, system: 'gemini', foundCount: 0, skippedCount: skipped, truncated, reasons: [...reasons] });
  return results;
}

function withPrecedence(
  artifacts: DiscoveredArtifact[],
  precedence: (artifact: DiscoveredArtifact) => number
): DiscoveredArtifact[] {
  return artifacts.map(artifact => ({ ...artifact, precedence: precedence(artifact) }));
}
