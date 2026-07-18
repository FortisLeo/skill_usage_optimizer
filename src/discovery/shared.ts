import { existsSync, lstatSync, opendirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DiscoveredArtifact, ArtifactKind, DiscoveryContext, SourceSystem } from '../types.js';
import { isSkillFile, isSkillEntry, MARKDOWN_EXTENSIONS, PRECEDENCE } from '../config.js';
import { isPathSafe, isWithinRoot, resolveRealpath } from '../fs/roots.js';

export const scannerLimits = {
  entries: 10_000,
  results: 500,
  fileBytes: 1024 * 1024,
  pathBytes: 4096
} as const;
export type ScannerLimits = Readonly<{ entries: number; results: number; fileBytes: number; pathBytes: number }>;

export interface ScanBudget {
  readonly limits: ScannerLimits;
  readonly entries: number;
  readonly artifacts: number;
  readonly exhausted: boolean;
  readonly exhaustionReason: 'entry_limit' | 'result_limit' | null;
  visit(): boolean;
  emit(): boolean;
  claimTruncation(): boolean;
}

export function createScanBudget(limits: ScannerLimits = scannerLimits): ScanBudget {
  let entries = 0;
  let artifacts = 0;
  let exhaustionReason: ScanBudget['exhaustionReason'] = null;
  let truncationClaimed = false;
  const consume = (kind: 'entry_limit' | 'result_limit'): boolean => {
    if (exhaustionReason) return false;
    const used = kind === 'entry_limit' ? entries : artifacts;
    const limit = kind === 'entry_limit' ? limits.entries : limits.results;
    if (used >= limit) { exhaustionReason = kind; return false; }
    if (kind === 'entry_limit') entries++;
    else artifacts++;
    return true;
  };
  return {
    limits,
    get entries() { return entries; },
    get artifacts() { return artifacts; },
    get exhausted() { return exhaustionReason !== null; },
    get exhaustionReason() { return exhaustionReason; },
    visit: () => consume('entry_limit'),
    emit: () => consume('result_limit'),
    claimTruncation: () => {
      if (!exhaustionReason || truncationClaimed) return false;
      truncationClaimed = true;
      return true;
    }
  };
}

export const EXPLICIT_ROOT_GUIDANCE = 'Pass trusted directories in index_skills.roots.';

export type ScanSkipReason = 'entry_limit' | 'result_limit' | 'file_size' | 'path_length' | 'symlink' | 'unsafe' | 'inaccessible';

export interface ScanSafetyResult {
  root: string;
  system: SourceSystem;
  foundCount: number;
  skippedCount: number;
  truncated: boolean;
  reasons: ScanSkipReason[];
}

export type ScanSafetyCallback = (result: ScanSafetyResult) => void;

export function reportBudgetExhaustion(
  budget: ScanBudget,
  root: string,
  system: SourceSystem,
  onScan?: ScanSafetyCallback,
  foundCount = 0
): void {
  if (!budget.claimTruncation()) return;
  onScan?.({ root, system, foundCount, skippedCount: 1, truncated: true, reasons: [budget.exhaustionReason ?? 'entry_limit'] });
}

interface ScanState {
  readonly realRoot: string;
  readonly allowedRoots: string[];
  readonly ctx: DiscoveryContext;
  readonly system: SourceSystem;
  readonly rootOrigin: string;
  readonly budget: ScanBudget;
  skipped: number;
  truncated: boolean;
  reasons: Set<ScanSkipReason>;
  seenArtifacts: Set<string>;
  results: DiscoveredArtifact[];
}

function skip(state: ScanState, reason: ScanSkipReason, truncated = false): void {
  state.skipped++;
  state.reasons.add(reason);
  if (truncated) {
    state.truncated = true;
  }
}

function visit(state: ScanState): boolean {
  if (state.truncated) return false;
  if (!state.budget.visit()) { skip(state, state.budget.exhaustionReason ?? 'entry_limit', true); return false; }
  return true;
}

function safePath(path: string, state: ScanState): boolean {
  if (Buffer.byteLength(path, 'utf8') > state.budget.limits.pathBytes) {
    skip(state, 'path_length');
    return false;
  }
  try {
    if (!isPathSafe(path, [state.realRoot]) || !isPathSafe(path, state.allowedRoots)) {
      skip(state, 'unsafe');
      return false;
    }
  } catch {
    skip(state, 'inaccessible');
    return false;
  }
  return true;
}

function addFile(
  path: string,
  state: ScanState,
  kind: ArtifactKind
): void {
  if (state.truncated || !safePath(path, state)) return;
  let realPath: string;
  let stat: ReturnType<typeof statSync>;
  try {
    const linkStat = lstatSync(path);
    if (linkStat.isSymbolicLink()) {
      skip(state, 'symlink');
      return;
    }
    stat = statSync(path);
    realPath = resolveRealpath(path);
  } catch {
    skip(state, 'inaccessible');
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > state.budget.limits.fileBytes) {
    skip(state, 'file_size');
    return;
  }
  if (state.seenArtifacts.has(realPath)) return;
  if (!state.budget.emit()) { skip(state, state.budget.exhaustionReason ?? 'result_limit', true); return; }
  state.seenArtifacts.add(realPath);
  state.results.push({
    system: state.system,
    kind,
    absolutePath: path,
    relativePath: relative(state.ctx.workspaceRoot || state.rootOrigin, path),
    rootOrigin: state.rootOrigin,
    precedence: precedenceFromRoot(state.rootOrigin, state.ctx),
    configIndirection: null,
    rawStat: { mtimeMs: stat.mtimeMs, size: stat.size, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs }
  });
}

function runScan(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  system: SourceSystem,
  rootOrigin: string,
  onScan: ScanSafetyCallback | undefined,
  scan: (state: ScanState) => void,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  if (budget.exhausted) return [];
  if (!existsSync(root)) return [];
  try {
    if (lstatSync(root).isSymbolicLink()) {
      onScan?.({ root, system, foundCount: 0, skippedCount: 1, truncated: false, reasons: ['symlink'] });
      return [];
    }
  } catch {
    onScan?.({ root, system, foundCount: 0, skippedCount: 1, truncated: false, reasons: ['inaccessible'] });
    return [];
  }
  let realRoot: string;
  try { realRoot = resolveRealpath(root); } catch {
    onScan?.({ root, system, foundCount: 0, skippedCount: 1, truncated: false, reasons: ['inaccessible'] });
    return [];
  }
  const state: ScanState = {
    realRoot,
    allowedRoots,
    ctx,
    system,
    rootOrigin,
    budget,
    skipped: 0,
    truncated: false,
    reasons: new Set(),
    seenArtifacts: new Set(),
    results: []
  };
  scan(state);
  if (!state.truncated || budget.claimTruncation()) {
    onScan?.({
      root,
      system,
      foundCount: state.results.length,
      skippedCount: state.skipped,
      truncated: state.truncated,
      reasons: [...state.reasons]
    });
  }
  return state.results;
}

/** Scan one supplied artifact root with one shared entry/result budget. */
export function scanSourceRoot(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  forcedSystem: SourceSystem,
  maxDepth = 3,
  onScan?: ScanSafetyCallback,
  limits: ScannerLimits = scannerLimits,
  budget: ScanBudget = createScanBudget(limits)
): DiscoveredArtifact[] {
  return runScan(root, allowedRoots, ctx, forcedSystem, root, onScan, state => {
    scanSource(root, maxDepth, 0, state);
  }, budget);
}

function scanSource(
  dirPath: string,
  maxDepth: number,
  depth: number,
  state: ScanState
): void {
  if (state.truncated || depth > maxDepth || !safePath(dirPath, state)) return;
  try {
    const dir = opendirSync(dirPath);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (!visit(state)) return;
        const abs = join(dirPath, entry.name);
        if (entry.isSymbolicLink()) {
          skip(state, 'symlink');
        } else if (entry.isFile()) {
          if (depth === 0 && isSkillFile(entry.name)) addFile(abs, state, classifyArtifact(entry.name));
          else if ((depth === 1 && isSkillEntry(entry.name)) || entry.name === 'SKILL.md') addFile(abs, state, 'skill_package');
        } else if (entry.isDirectory() && depth < maxDepth && isSkillDir(entry.name)) {
          scanSource(abs, maxDepth, depth + 1, state);
        }
        if (state.truncated) return;
      }
    } finally { dir.closeSync(); }
  } catch { skip(state, 'inaccessible'); }
}

function classifyArtifact(filename: string): ArtifactKind {
  const lower = filename.toLowerCase();
  if (lower === 'skill.md' || lower === 'instructions.md') return 'skill_package';
  if (lower === 'rules.md') return 'rule_file';
  if (lower.includes('convention') || lower.includes('style')) return 'convention_file';
  if (MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'instruction_file';
  return 'pseudo_skill';
}

function isSkillDir(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules';
}

export function scanExplicitRoots(
  explicitRoots: string[],
  allowedRoots: string[],
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback
): { artifacts: DiscoveredArtifact[]; errors: { path: string; error: string }[] } {
  const results: DiscoveredArtifact[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const root of explicitRoots) {
    if (!existsSync(root)) {
      errors.push({ path: root, error: `explicit root does not exist: ${root}` });
      continue;
    }
    try {
      const st = statSync(root);
      if (!st.isDirectory()) {
        errors.push({ path: root, error: `explicit root is not a directory: ${root}` });
        continue;
      }
      if (lstatSync(root).isSymbolicLink()) {
        errors.push({ path: root, error: `explicit root could not be resolved safely: ${root}` });
        continue;
      }
    } catch {
      errors.push({ path: root, error: `explicit root not accessible: ${root}` });
      continue;
    }
    try {
      if (!isPathSafe(root, allowedRoots)) {
        errors.push({ path: root, error: `explicit root outside allowed roots: ${root}` });
        continue;
      }
    } catch {
      errors.push({ path: root, error: `explicit root could not be resolved: ${root}` });
      continue;
    }
    const system = ctx.explicitRootSystem ?? sourceSystemFromRoot(root);
    if (!system) {
      errors.push({ path: root, error: `unknown explicit root source system: ${root}` });
      continue;
    }
    results.push(...scanSourceRoot(root, allowedRoots, ctx, system, 3, onScan));
  }
  return { artifacts: results, errors };
}

export function scanRootInstructionFiles(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  forcedSystem: SourceSystem,
  onScan?: ScanSafetyCallback
): DiscoveredArtifact[] {
  return runScan(baseDir, allowedRoots, ctx, forcedSystem, baseDir, onScan, state => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      if (!visit(state)) return;
      const abs = join(baseDir, name);
      if (!existsSync(abs)) continue;
      addFile(abs, state, 'instruction_file');
    }
  });
}

export function scanFile(
  absolutePath: string,
  scanRoot: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  forcedSystem: SourceSystem,
  kind: ArtifactKind,
  rootOrigin = scanRoot,
  onScan?: ScanSafetyCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  return runScan(scanRoot, allowedRoots, ctx, forcedSystem, rootOrigin, onScan, state => {
    if (!visit(state)) return;
    if (!existsSync(absolutePath) && Buffer.byteLength(absolutePath, 'utf8') <= budget.limits.pathBytes) return;
    addFile(absolutePath, state, kind);
  }, budget);
}

export function scanCopilotInstructions(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  forcedSystem: SourceSystem,
  maxDepth = 4,
  onScan?: ScanSafetyCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  return scanMarkdownRoot(join(baseDir, '.github', 'instructions'), allowedRoots, ctx, forcedSystem, '.instructions.md', 'instruction_file', maxDepth, onScan, budget);
}

export function scanMarkdownRoot(
  root: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  forcedSystem: SourceSystem,
  suffix: string,
  kind: ArtifactKind,
  maxDepth = 4,
  onScan?: ScanSafetyCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  return runScan(root, allowedRoots, ctx, forcedSystem, root, onScan, state => {
    const walk = (dir: string, depth: number): void => {
      if (state.truncated || depth > maxDepth || !safePath(dir, state)) return;
      try {
        const handle = opendirSync(dir);
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (!visit(state)) return;
            const abs = join(dir, entry.name);
            if (entry.isSymbolicLink()) skip(state, 'symlink');
            else if (entry.isFile() && entry.name.endsWith(suffix)) addFile(abs, state, kind);
            else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') walk(abs, depth + 1);
            if (state.truncated) return;
          }
        } finally { handle.closeSync(); }
      } catch { skip(state, 'inaccessible'); }
    };
    walk(root, 0);
  }, budget);
}

function sourceSystemFromRoot(root: string): SourceSystem | null {
  if (root.includes('.claude') || root.includes('/claude/')) return 'claude';
  if (root.includes('.opencode') || root.includes('/opencode/') || root.endsWith('/opencode')) return 'opencode';
  if (root.includes('.codex') || root.includes('/codex/')) return 'codex';
  if (root.includes('github/copilot') || root.includes('.github/copilot') || root.includes('.github/instructions')) return 'copilot';
  if (root.includes('.roo') || root.includes('/roo/')) return 'roo';
  if (root.includes('.continue') || root.includes('/continue/')) return 'continue';
  return null;
}

export function precedenceFromRoot(root: string, ctx: DiscoveryContext): number {
  const realRoot = resolveRealpath(root);
  if (ctx.explicitRoots.some(r => {
    try { return resolveRealpath(r) === realRoot; } catch { return false; }
  })) return PRECEDENCE.explicit;
  if (ctx.workspaceRoot && ctx.repoRoot) {
    try {
      const realWorkspace = resolveRealpath(ctx.workspaceRoot);
      const realRepo = resolveRealpath(ctx.repoRoot);
      if (realWorkspace !== realRepo && isWithinRoot(realWorkspace, realRepo) && isWithinRoot(realRoot, realWorkspace)) return PRECEDENCE.workspace_root;
    } catch { /* roots may disappear during discovery */ }
  }
  if (ctx.repoRoot && isWithinRoot(realRoot, ctx.repoRoot)) return PRECEDENCE.workspace_repo;
  if (ctx.workspaceRoot && isWithinRoot(realRoot, ctx.workspaceRoot)) return PRECEDENCE.workspace_root;
  try {
    if (isWithinRoot(realRoot, ctx.homeDir)) return PRECEDENCE.global;
  } catch { /* homeDir may not exist */ }
  return PRECEDENCE.system;
}

export function projectChain(ctx: DiscoveryContext): string[] {
  if (!ctx.workspaceRoot) return ctx.repoRoot ? [ctx.repoRoot] : [];
  if (!ctx.repoRoot || ctx.repoRoot === ctx.workspaceRoot) return [ctx.workspaceRoot];
  try {
    if (!isWithinRoot(ctx.workspaceRoot, ctx.repoRoot)) return [ctx.repoRoot, ctx.workspaceRoot];
  } catch { return [ctx.repoRoot, ctx.workspaceRoot]; }
  const chain = [ctx.repoRoot];
  for (const part of relative(ctx.repoRoot, ctx.workspaceRoot).split(sep).filter(Boolean)) chain.push(join(chain[chain.length - 1]!, part));
  return chain;
}
