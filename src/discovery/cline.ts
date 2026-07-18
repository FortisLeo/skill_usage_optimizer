import { existsSync, lstatSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scanMarkdownRoot, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';
const RULE_SUBTREES = new Set(['hooks', 'skills', 'workflows']);
type ClineDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverCline(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: ClineDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const allowedRoots = collectAllowedRoots(ctx);
  const projectRoots = [ctx.repoRoot, ctx.workspaceRoot].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
  const results: DiscoveredArtifact[] = [];
  let configCount = 0;

  for (const base of projectRoots) {
    const legacy = join(base, '.clinerules');
    results.push(...scanClineRules(legacy, base, allowedRoots, ctx, onScan, budget));
    results.push(...scanFile(join(base, 'AGENTS.md'), base, allowedRoots, ctx, 'cline', 'instruction_file', base, onScan, budget));
    for (const name of ['.cursorrules', '.windsurfrules']) results.push(...scanFile(join(base, name), base, allowedRoots, ctx, 'cline', 'rule_file', base, onScan, budget));
    for (const root of [join(base, '.cline', 'skills'), join(base, '.clinerules', 'skills'), join(base, '.claude', 'skills')]) {
      results.push(...scanSourceRoot(root, allowedRoots, ctx, 'cline', 3, onScan, scannerLimits, budget));
    }
    const configured = scanRules(join(base, '.cline', 'rules'), allowedRoots, ctx, onScan, budget).map(artifact => ({ ...artifact, precedence: artifact.precedence + 1 }));
    configCount += configured.length;
    results.push(...configured);
  }

  if (ctx.includeGlobals) {
    for (const root of [join(ctx.homeDir, '.cline', 'skills')]) results.push(...scanSourceRoot(root, allowedRoots, ctx, 'cline', 3, onScan, scannerLimits, budget));
    results.push(...scanFile(join(ctx.homeDir, '.agents', 'AGENTS.md'), join(ctx.homeDir, '.agents'), allowedRoots, ctx, 'cline', 'instruction_file', ctx.homeDir, onScan, budget));
    const globalRuleRoots = [join(ctx.homeDir, '.cline', 'rules'), join(ctx.homeDir, 'Documents', 'Cline', 'Rules')];
    if (process.platform === 'linux') globalRuleRoots.push(join(ctx.homeDir, 'Cline', 'Rules'));
    for (const root of globalRuleRoots) {
      const configured = scanRules(root, allowedRoots, ctx, onScan, budget);
      configCount += configured.length;
      results.push(...configured);
    }
  }

  if (results.length === 0) onDiagnostic?.(diagnostic('roots', 'roots', 'unavailable', 'SOURCE_ABSENT', 0, 'No supported Cline documented roots were present.'));
  onDiagnostic?.(diagnostic(
    'configuration', 'configuration', configCount > 0 ? 'used' : 'unavailable', configCount > 0 ? 'SOURCE_USED' : 'SOURCE_ABSENT', configCount,
    configCount > 0 ? 'Stable readable Cline rule configuration roots were used.' : 'No stable readable Cline rule configuration root was present.'
  ));
  onDiagnostic?.(diagnostic(
    'configuration', 'configuration', 'unavailable', 'SOURCE_UNSUPPORTED', 0,
    'Rule toggles, active Plan or Act mode, private settings, remote rules, session state, and final prompt reconstruction are unsupported.'
  ));
  return results;
}

function scanClineRules(
  path: string, base: string, allowedRoots: string[], ctx: DiscoveryContext, onScan: ScanSafetyCallback | undefined, budget: ScanBudget
): DiscoveredArtifact[] {
  if (!existsSync(path)) return [];
  try {
    if (lstatSync(path).isDirectory()) {
      return scanRules(path, allowedRoots, ctx, onScan, budget).filter(artifact => !RULE_SUBTREES.has(relative(path, artifact.absolutePath).split(/[\\/]/)[0] ?? ''));
    }
  } catch { /* shared scanner reports unsafe or inaccessible paths */ }
  return scanFile(path, base, allowedRoots, ctx, 'cline', 'rule_file', base, onScan, budget);
}

function scanRules(root: string, allowedRoots: string[], ctx: DiscoveryContext, onScan: ScanSafetyCallback | undefined, budget: ScanBudget): DiscoveredArtifact[] {
  return scanMarkdownRoot(root, allowedRoots, ctx, 'cline', '', 'rule_file', 4, onScan, budget)
    .filter(artifact => ['.md', '.txt'].includes(extname(artifact.absolutePath).toLowerCase()));
}

function diagnostic(
  capability: DiscoveryDiagnostic['capability'], sourceType: DiscoveryDiagnostic['sourceType'], status: DiscoveryDiagnostic['status'],
  code: DiscoveryDiagnostic['code'], foundCount: number, limitation: string
): DiscoveryDiagnostic {
  return { environment: 'cline', capability, sourceType, status, code, foundCount: Math.min(foundCount, scannerLimits.results), skippedCount: 0, limitation, explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE };
}
