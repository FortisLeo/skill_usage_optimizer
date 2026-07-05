import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DiscoveredArtifact, ArtifactKind, DiscoveryContext, SourceSystem } from '../types.js';
import { isSkillFile, isSkillEntry, MARKDOWN_EXTENSIONS, PRECEDENCE } from '../config.js';
import { isPathSafe, isWithinRoot, resolveRealpath } from '../fs/roots.js';

export function scanDir(root: string, allowedRoots: string[], ctx: DiscoveryContext, forcedSystem?: SourceSystem): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  if (!existsSync(root)) return results;
  const real = resolveRealpath(root);
  const system = forcedSystem ?? sourceSystemFromRoot(root, ctx);
  if (!system) return results;

  try {
    const entries = readdirSync(real, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(root, entry.name);
      if (!isPathSafe(abs, allowedRoots)) continue;

      if (entry.isFile() && isSkillFile(entry.name)) {
        const stat = statSync(abs);
        const kind = classifyArtifact(entry.name, real);
        results.push({
          system,
          kind,
          absolutePath: abs,
          relativePath: relative(ctx.workspaceRoot || root, abs),
          rootOrigin: root,
          precedence: precedenceFromRoot(root, ctx),
          configIndirection: null,
          rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
        });
      } else if (entry.isDirectory() && isSkillDir(entry.name)) {
        // A directory like "my-skill/" may contain SKILL.md
        results.push(...scanSkillDir(abs, allowedRoots, ctx, root, forcedSystem));
      }
    }
  } catch { /* skip inaccessible dirs */ }

  return results;
}

function scanSkillDir(dirPath: string, allowedRoots: string[], ctx: DiscoveryContext, rootOrigin: string, forcedSystem?: SourceSystem): DiscoveredArtifact[] {
  const results: DiscoveredArtifact[] = [];
  const system = forcedSystem ?? sourceSystemFromRoot(rootOrigin, ctx);
  if (!system) return results;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dirPath, entry.name);
      if (!isPathSafe(abs, allowedRoots)) continue;
      if (entry.isFile() && isSkillEntry(entry.name)) {
        const stat = statSync(abs);
        results.push({
          system,
          kind: 'skill_package',
          absolutePath: abs,
          relativePath: relative(ctx.workspaceRoot || rootOrigin, abs),
          rootOrigin,
          precedence: precedenceFromRoot(rootOrigin, ctx),
          configIndirection: null,
          rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
        });
      }
    }
  } catch { /* skip */ }
  return results;
}

function classifyArtifact(filename: string, rootDir: string): ArtifactKind {
  const lower = filename.toLowerCase();
  if (lower === 'skill.md' || lower === 'instructions.md') return 'skill_package';
  if (lower === 'rules.md') return 'rule_file';
  if (lower.includes('convention') || lower.includes('style')) return 'convention_file';
  if (MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext))) return 'instruction_file';
  return 'pseudo_skill';
}

function isSkillDir(name: string): boolean {
  // A reasonable skill directory won't start with '.' and won't be 'node_modules'
  return !name.startsWith('.') && name !== 'node_modules';
}

// Recursively find SKILL.md files under a directory, bounded to maxDepth levels
// from the start dir (inclusive).  Respects allowedRoots and isPathSafe at every step.
export function scanSkillRecursive(
  dirPath: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  rootOrigin: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
  forcedSystem?: SourceSystem
): DiscoveredArtifact[] {
  if (currentDepth > maxDepth) return [];
  if (!existsSync(dirPath)) return [];
  const system = forcedSystem ?? sourceSystemFromRoot(rootOrigin, ctx);
  if (!system) return [];
  const results: DiscoveredArtifact[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dirPath, entry.name);
      if (!isPathSafe(abs, allowedRoots)) continue;
      if (entry.isFile() && entry.name === 'SKILL.md') {
        const stat = statSync(abs);
        results.push({
          system,
          kind: 'skill_package',
          absolutePath: abs,
          relativePath: relative(ctx.workspaceRoot || rootOrigin, abs),
          rootOrigin,
          precedence: precedenceFromRoot(rootOrigin, ctx),
          configIndirection: null,
          rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
        });
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...scanSkillRecursive(abs, allowedRoots, ctx, rootOrigin, maxDepth, currentDepth + 1, forcedSystem));
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

// Scan a flat list of explicit roots for any skill files plus recursive SKILL.md.
export function scanExplicitRoots(
  explicitRoots: string[],
  allowedRoots: string[],
  ctx: DiscoveryContext
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
    } catch (err) {
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
    const system = ctx.explicitRootSystem ?? sourceSystemFromRoot(root, ctx);
    if (!system) {
      errors.push({ path: root, error: `unknown explicit root source system: ${root}` });
      continue;
    }
    try {
      results.push(...scanDir(root, allowedRoots, ctx, system));
      // Also recursively find SKILL.md under explicit roots.
      results.push(...scanSkillRecursive(root, allowedRoots, ctx, root, 3, 0, system));
    } catch { /* skip */ }
  }
  return { artifacts: results, errors };
}

// Discover root-level instruction files in a given base directory.
// Covers: AGENTS.md, CLAUDE.md (claude), .github/copilot-instructions.md (copilot)
export function scanRootInstructionFiles(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext
): DiscoveredArtifact[] {
  if (!existsSync(baseDir)) return [];
  const results: DiscoveredArtifact[] = [];

  const rootFiles: { name: string; system: SourceSystem; kind: ArtifactKind }[] = [
    { name: 'AGENTS.md',  system: 'claude',  kind: 'instruction_file' },
    { name: 'CLAUDE.md',  system: 'claude',  kind: 'instruction_file' },
  ];

  for (const { name, system, kind } of rootFiles) {
    const abs = join(baseDir, name);
    if (!existsSync(abs)) continue;
    if (!isPathSafe(abs, allowedRoots)) continue;
    try {
      const stat = statSync(abs);
      results.push({
        system,
        kind,
        absolutePath: abs,
        relativePath: relative(ctx.workspaceRoot || baseDir, abs),
        rootOrigin: baseDir,
        precedence: precedenceFromRoot(baseDir, ctx),
        configIndirection: null,
        rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
      });
    } catch { /* skip */ }
  }

  return results;
}

// Scan .github/instructions/** for *.instructions.md files (recursive, copilot).
export function scanCopilotInstructions(
  baseDir: string,
  allowedRoots: string[],
  ctx: DiscoveryContext,
  maxDepth: number = 4
): DiscoveredArtifact[] {
  const root = join(baseDir, '.github', 'instructions');
  if (!existsSync(root)) return [];
  const results: DiscoveredArtifact[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (!isPathSafe(abs, allowedRoots)) continue;
        if (entry.isFile() && entry.name.endsWith('.instructions.md')) {
          const stat = statSync(abs);
          results.push({
            system: 'copilot',
            kind: 'instruction_file',
            absolutePath: abs,
            relativePath: relative(ctx.workspaceRoot || baseDir, abs),
            rootOrigin: root,
            precedence: precedenceFromRoot(root, ctx),
            configIndirection: null,
            rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
          });
        } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(abs, depth + 1);
        }
      }
    } catch { /* skip */ }
  }

  walk(root, 0);
  return results;
}

function sourceSystemFromRoot(root: string, ctx: DiscoveryContext): SourceSystem | null {
  if (root.includes('.claude') || root.includes('/claude/')) return 'claude';
  if (root.includes('.opencode') || root.includes('/opencode/') || root.endsWith('/opencode')) return 'opencode';
  if (root.includes('.codex') || root.includes('/codex/')) return 'codex';
  if (root.includes('github/copilot') || root.includes('.github/copilot') || root.includes('.github/instructions')) return 'copilot';
  return null;
}

export function precedenceFromRoot(root: string, ctx: DiscoveryContext): number {
  const realRoot = resolveRealpath(root);

  // repo (100) before workspace_root (80): if a path is inside both, repo wins.
  if (ctx.repoRoot) {
    if (isWithinRoot(realRoot, ctx.repoRoot)) return PRECEDENCE.workspace_repo;
  }
  // explicit (70) before global (40)
  if (ctx.explicitRoots.some(r => {
    try { return resolveRealpath(r) === realRoot; } catch { return false; }
  })) return PRECEDENCE.explicit;

  if (ctx.workspaceRoot && isWithinRoot(realRoot, ctx.workspaceRoot)) return PRECEDENCE.workspace_root;

  // homeDir may be a symlink; realpath it for comparison
  try {
    if (isWithinRoot(realRoot, ctx.homeDir)) return PRECEDENCE.global;
  } catch { /* homeDir may not exist on some systems */ }

  return PRECEDENCE.system;
}
