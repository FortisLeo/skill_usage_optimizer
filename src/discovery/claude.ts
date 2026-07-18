import { existsSync, lstatSync, opendirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactKind, DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { GLOBAL_SKILL_DIRS } from '../config.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, reportBudgetExhaustion, scanFile, scanSourceRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback, type ScanSkipReason } from './shared.js';
const EXCLUDED_DIRECTORIES = new Set(['.git', '.cache', '.skill-cache', '.next', 'node_modules', 'cache', 'caches', 'coverage', 'vendor', 'dist', 'build', 'target']);
const MAX_PROJECT_DEPTH = 3;

export type ClaudeDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverClaude(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: ClaudeDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const allowedRoots = collectAllowedRoots(ctx);

  if (ctx.workspaceRoot) results.push(...scanProject(ctx.workspaceRoot, allowedRoots, ctx, onScan, budget));
  if (ctx.repoRoot && ctx.repoRoot !== ctx.workspaceRoot) results.push(...scanProject(ctx.repoRoot, allowedRoots, ctx, onScan, budget));

  if (ctx.includeGlobals) {
    for (const dir of GLOBAL_SKILL_DIRS.claude) {
      const root = join(ctx.homeDir, dir);
      results.push(...scanClaudeRoot(root, allowedRoots, ctx, onScan, budget));
    }
    results.push(...scanInstruction(join(ctx.homeDir, '.claude', 'CLAUDE.md'), join(ctx.homeDir, '.claude'), allowedRoots, ctx, onScan, budget));
  }

  if (results.length === 0) onDiagnostic?.({
    environment: 'claude', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT',
    foundCount: 0, skippedCount: 0,
    limitation: 'No supported Claude Code documented roots were present.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });
  onDiagnostic?.({
    environment: 'claude', capability: 'configuration', sourceType: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED',
    foundCount: 0, skippedCount: 0,
    limitation: 'Plugin-installed and runtime-effective sources have no stable discovery API; only documented roots are scanned.',
    explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  });

  return results;
}

function scanProject(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const add = (artifacts: DiscoveredArtifact[]): void => { results.push(...artifacts); };
  walkBounded(baseDir, allowedRoots, onScan, budget, (dir, depth, names) => {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
      if (names.has(name)) add(scanInstruction(join(dir, name), dir, allowedRoots, ctx, onScan, budget));
    }
    if (!names.has('.claude')) return;
    const claudeDir = join(dir, '.claude');
    add(scanInstruction(join(claudeDir, 'CLAUDE.md'), claudeDir, allowedRoots, ctx, onScan, budget));
    add(scanSourceRoot(join(claudeDir, 'skills'), allowedRoots, ctx, 'claude', 3, onScan, scannerLimits, budget));
    if (depth === 0) {
      add(scanMarkdownTree(join(claudeDir, 'commands'), allowedRoots, ctx, 'instruction_file', onScan, budget));
      add(scanMarkdownTree(join(claudeDir, 'rules'), allowedRoots, ctx, 'rule_file', onScan, budget));
    }
  });
  return results;
}

function scanClaudeRoot(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  if (root.endsWith('/rules') || root.endsWith('\\rules')) return scanMarkdownTree(root, allowedRoots, ctx, 'rule_file', onScan, budget);
  if (root.endsWith('/commands') || root.endsWith('\\commands')) return scanMarkdownTree(root, allowedRoots, ctx, 'instruction_file', onScan, budget);
  return scanSourceRoot(root, allowedRoots, ctx, 'claude', 3, onScan, scannerLimits, budget);
}

function scanMarkdownTree(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  kind: ArtifactKind,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  walkBounded(root, allowedRoots, onScan, budget, (dir, _depth, names) => {
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      results.push(...scanFile(join(dir, name), root, allowedRoots, ctx, 'claude', kind, root, onScan, budget));
    }
  });
  return results;
}

function scanInstruction(
  file: string,
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget
): DiscoveredArtifact[] {
  return scanFile(file, root, allowedRoots, ctx, 'claude', 'instruction_file', root, onScan, budget);
}

function walkBounded(
  root: string,
  allowedRoots: string[],
  onScan: ScanSafetyCallback | undefined,
  budget: ScanBudget,
  visit: (dir: string, depth: number, names: Set<string>) => void
): void {
  if (budget.exhausted || !existsSync(root)) return;
  let skipped = 0;
  let truncated = false;
  const reasons = new Set<ScanSkipReason>();

  const skip = (reason: ScanSkipReason, stop = false): void => {
    skipped++;
    reasons.add(reason);
    truncated ||= stop;
  };
  const walk = (dir: string, depth: number): void => {
    if (truncated || budget.exhausted || depth > MAX_PROJECT_DEPTH) return;
    if (Buffer.byteLength(dir, 'utf8') > budget.limits.pathBytes) {
      skip('path_length');
      return;
    }
    try {
      if (lstatSync(dir).isSymbolicLink() || !isPathSafe(dir, [root]) || !isPathSafe(dir, allowedRoots)) {
        skip('symlink');
        return;
      }
      const boundedChildren: Dirent[] = [];
      const handle = opendirSync(dir);
      try {
        for (let child = handle.readSync(); child; child = handle.readSync()) {
          if (!budget.visit()) {
            skip('entry_limit', true);
            break;
          }
          boundedChildren.push(child);
        }
      } finally { handle.closeSync(); }
      const names = new Set(boundedChildren.map(child => child.name));
      visit(dir, depth, names);
      if (truncated) return;
      for (const child of boundedChildren) {
        if (!child.isDirectory()) {
          if (child.isSymbolicLink()) skip('symlink');
          continue;
        }
        if (child.isSymbolicLink()) {
          skip('symlink');
          continue;
        }
        if (depth >= MAX_PROJECT_DEPTH || child.name === '.claude' || child.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(child.name)) continue;
        walk(join(dir, child.name), depth + 1);
        if (truncated) return;
      }
    } catch { skip('inaccessible'); }
  };

  walk(root, 0);
  if (truncated && budget.exhausted) { reportBudgetExhaustion(budget, root, 'claude', onScan); return; }
  if (skipped > 0) onScan?.({ root, system: 'claude', foundCount: 0, skippedCount: skipped, truncated, reasons: [...reasons] });
}
