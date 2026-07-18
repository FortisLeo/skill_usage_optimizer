import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, projectChain, reportBudgetExhaustion, scanFile, scanMarkdownRoot, type ScanBudget, type ScanSafetyCallback, type ScanSkipReason } from './shared.js';
const MAX_WORKSPACE_DEPTH = 5;
const EXCLUDED = new Set(['.git', '.cache', '.skill-cache', 'node_modules', 'cache', 'caches', 'dist', 'build', 'target', 'vendor']);

export type WindsurfDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverWindsurf(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: WindsurfDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);
  const chain = projectChain(ctx);

  for (const dir of chain.slice(0, -1)) results.push(...scanDirectorySources(dir, 0, allowedRoots, ctx, onScan, budget));
  const workspace = chain.at(-1);
  if (workspace) results.push(...scanWorkspace(workspace, allowedRoots, ctx, onScan, budget));

  if (ctx.includeGlobals) {
    const globalRoot = join(ctx.homeDir, '.codeium', 'windsurf', 'memories');
    results.push(...withOffset(scanFile(
      join(globalRoot, 'global_rules.md'), globalRoot, allowedRoots, ctx,
      'windsurf', 'rule_file', globalRoot, onScan, budget
    ), 0));
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'windsurf', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported Devin Desktop or legacy Windsurf rule roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'windsurf', capability: 'configuration', sourceType: 'configuration', status: 'limited', code: 'SOURCE_UNSUPPORTED',
    foundCount: results.length, skippedCount: 0,
    limitation: 'Activation, final-prompt state, auto memories, private/cache state, and administrator-managed enterprise rules are not read.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  return results;
}

function scanWorkspace(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const reasons = new Set<ScanSkipReason>();
  let skipped = 0;
  let truncated = false;
  const mark = (reason: ScanSkipReason, stop = false): void => { skipped++; reasons.add(reason); truncated ||= stop; };
  const add = (artifacts: DiscoveredArtifact[]): void => { results.push(...artifacts); };

  const walk = (dir: string, depth: number): void => {
    if (truncated || budget.exhausted || depth > MAX_WORKSPACE_DEPTH) return;
    if (Buffer.byteLength(dir, 'utf8') > budget.limits.pathBytes) { mark('path_length'); return; }
    try {
      if (lstatSync(dir).isSymbolicLink() || !isPathSafe(dir, [root]) || !isPathSafe(dir, allowedRoots)) { mark('unsafe'); return; }
    } catch { mark('inaccessible'); return; }
    add(scanDirectorySources(dir, depth, allowedRoots, ctx, onScan, budget));
    if (truncated || budget.exhausted) return;
    if (depth === MAX_WORKSPACE_DEPTH) return;
    try {
      const handle = opendirSync(dir);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (!budget.visit()) { mark('entry_limit', true); return; }
          if (entry.isSymbolicLink()) { mark('symlink'); continue; }
          if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDED.has(entry.name)) continue;
          walk(join(dir, entry.name), depth + 1);
          if (truncated) return;
        }
      } finally { handle.closeSync(); }
    } catch { mark('inaccessible'); }
  };

  walk(root, 0);
  if (truncated && budget.exhausted) { reportBudgetExhaustion(budget, root, 'windsurf', onScan, results.length); return results; }
  if (skipped > 0) onScan?.({ root, system: 'windsurf', foundCount: results.length, skippedCount: skipped, truncated, reasons: [...reasons] });
  return results;
}

function scanDirectorySources(
  dir: string,
  depth: number,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  for (const name of ['AGENTS.md', 'agents.md']) {
    const instruction = scanFile(join(dir, name), dir, allowedRoots, ctx, 'windsurf', 'instruction_file', dir, onScan, budget);
    if (instruction.length > 0) {
      results.push(...withOffset(instruction, depth));
      break;
    }
  }

  const current = scanMarkdownRoot(join(dir, '.devin', 'rules'), allowedRoots, ctx, 'windsurf', '.md', 'rule_file', 4, onScan, budget);
  if (current.length > 0) results.push(...withOffset(current, depth + 2));
  else results.push(...withOffset(scanMarkdownRoot(join(dir, '.windsurf', 'rules'), allowedRoots, ctx, 'windsurf', '.md', 'rule_file', 4, onScan, budget), depth + 1));

  if (depth === 0) {
    results.push(...withOffset(scanFile(join(dir, '.windsurfrules'), dir, allowedRoots, ctx, 'windsurf', 'rule_file', dir, onScan, budget), 0));
  }
  return results;
}

function withOffset(artifacts: DiscoveredArtifact[], offset: number): DiscoveredArtifact[] {
  return artifacts.map(artifact => ({ ...artifact, precedence: artifact.precedence + offset }));
}
