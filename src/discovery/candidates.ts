import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { SourceSystem } from '../types.js';
import { isPathSafe, resolveRealpath, validateRoot } from '../fs/roots.js';

export type DiscoveryScope = 'project' | 'home';
export type CandidateKind = 'skill_file' | 'skill_directory' | 'rule_directory' | 'instruction_file';

export interface SkillCandidate {
  path: string;
  system: SourceSystem;
  indexable: boolean;
  indexRoot?: string;
  kind: CandidateKind;
  matchedBy: 'SKILL.md' | 'skill.md' | 'known_harness_path' | 'skills_directory' | 'root_instruction_file';
}

export interface CandidateDiscoveryResult {
  scope: DiscoveryScope;
  root: string;
  candidates: SkillCandidate[];
  truncated: boolean;
}

const PROJECT_EXCLUDED = new Set(['.git', 'node_modules', 'Library', 'Downloads', 'Trash', 'Caches', 'vendor', 'dist', 'build', 'target']);
const HOME_TECHNICAL_EXCLUDED = new Set(['.git', 'node_modules', 'Caches', 'vendor', 'dist', 'build', 'target']);
const HOME_TOP_LEVEL_EXCLUDED = new Set(['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos']);
const HOME_PLATFORM_EXCLUDED: Record<NodeJS.Platform, Set<string>> = {
  aix: new Set(),
  android: new Set(),
  cygwin: new Set(),
  darwin: new Set(['Library', 'Movies', 'Applications', 'Trash']),
  freebsd: new Set(),
  haiku: new Set(),
  linux: new Set(),
  netbsd: new Set(),
  openbsd: new Set(),
  sunos: new Set(),
  win32: new Set(['AppData', 'Contacts', 'Favorites', 'Links', 'OneDrive', 'Saved Games', 'Searches', '3D Objects'])
};
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_LIMIT = 100;
const DEFAULT_SCAN_ENTRY_LIMIT = 10_000;

export const normalizeRelativePath = (path: string) => path.replaceAll('\\', '/');

const PROJECT_ROOTS: Array<{ path: string; system: SourceSystem; kind: CandidateKind }> = [
  { path: '.claude/skills', system: 'claude', kind: 'skill_directory' },
  { path: '.claude/commands', system: 'claude', kind: 'skill_directory' },
  { path: '.opencode/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.opencode/rules', system: 'opencode', kind: 'rule_directory' },
  { path: '.codex/skills', system: 'codex', kind: 'skill_directory' },
  { path: '.codex/agents', system: 'codex', kind: 'skill_directory' },
  { path: '.github/copilot', system: 'copilot', kind: 'skill_directory' },
  { path: '.github/instructions', system: 'copilot', kind: 'rule_directory' }
];

const HOME_ROOTS: Array<{ path: string; system: SourceSystem; kind: CandidateKind }> = [
  { path: '.claude/skills', system: 'claude', kind: 'skill_directory' },
  { path: '.opencode/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.config/opencode/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.codex/skills', system: 'codex', kind: 'skill_directory' },
  { path: '.github/copilot', system: 'copilot', kind: 'skill_directory' }
];

const PROJECT_INSTRUCTION_FILES: Array<{ path: string; system: SourceSystem }> = [
  { path: 'AGENTS.md', system: 'claude' },
  { path: 'CLAUDE.md', system: 'claude' },
  { path: '.github/copilot-instructions.md', system: 'copilot' }
];

/** Finds known harness roots and literal lowercase `skills` directories under the selected root. */
export function discoverSkillFolders(
  rootPath: string,
  scope: DiscoveryScope = 'project',
  maxDepth = DEFAULT_MAX_DEPTH,
  limit = DEFAULT_LIMIT,
  scanEntryLimit = DEFAULT_SCAN_ENTRY_LIMIT,
  platform: NodeJS.Platform = process.platform
): CandidateDiscoveryResult {
  const root = validateRoot(rootPath);
  const candidates: SkillCandidate[] = [];
  const visited = new Set<string>();
  const seen = new Set<string>();
  let truncated = false;
  let scannedEntries = 0;

  const add = (candidate: SkillCandidate) => {
    let key = candidate.path;
    if (candidate.indexRoot) {
      try { key = resolveRealpath(candidate.indexRoot); } catch { key = candidate.indexRoot; }
    }
    if (seen.has(key)) return true;
    if (candidates.length >= limit) {
      truncated = true;
      return false;
    }
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= limit) truncated = true;
    return !truncated;
  };

  const walkRoot = (dir: string, system: SourceSystem | undefined, depth: number) => {
    if (truncated || depth > maxDepth || !isPathSafe(dir, [root])) return;
    let real: string;
    try { real = resolveRealpath(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (scannedEntries >= scanEntryLimit) {
          truncated = true;
          return;
        }
        scannedEntries++;
        const absolute = join(dir, entry.name);
        const relativePath = normalizeRelativePath(relative(root, absolute));
        const excluded = scope === 'project'
          ? PROJECT_EXCLUDED.has(entry.name)
          : HOME_TECHNICAL_EXCLUDED.has(entry.name)
            || HOME_TOP_LEVEL_EXCLUDED.has(relativePath)
            || HOME_PLATFORM_EXCLUDED[platform].has(relativePath)
            || (platform === 'linux' && relativePath === '.local/share/Trash');
        if (truncated || entry.isSymbolicLink() || excluded) continue;
        if (!isPathSafe(absolute, [root])) continue;
        if (system && entry.isFile() && (entry.name === 'SKILL.md' || entry.name === 'skill.md')) {
          add({ path: normalizeRelativePath(relative(root, absolute)), system, indexable: true, indexRoot: dirname(absolute), kind: 'skill_file', matchedBy: entry.name });
        } else if (entry.isDirectory() && depth < maxDepth) {
          let childSystem = system;
          if (entry.name === 'skills') {
            const path = normalizeRelativePath(relative(root, absolute));
            const known = (scope === 'project' ? PROJECT_ROOTS : HOME_ROOTS).find(candidate => candidate.path === path);
            childSystem = known?.system ?? 'generic';
            if (!known) add({ path, system: 'generic', indexable: true, indexRoot: absolute, kind: 'skill_directory', matchedBy: 'skills_directory' });
          }
          walkRoot(absolute, childSystem, depth + 1);
        }
      }
    } catch { /* inaccessible directories are not candidates */ }
  };

  for (const candidate of scope === 'project' ? PROJECT_ROOTS : HOME_ROOTS) {
    if (truncated) break;
    const absolute = join(root, candidate.path);
    try {
      if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory() || !isPathSafe(absolute, [root])) continue;
    } catch { continue; }
    if (!add({ ...candidate, indexable: true, indexRoot: absolute, matchedBy: 'known_harness_path' })) continue;
    walkRoot(absolute, candidate.system, 0);
  }

  // This is the only broad walk, and only runs after an explicit tool call.
  walkRoot(root, undefined, 0);

  if (scope === 'project') {
    for (const candidate of PROJECT_INSTRUCTION_FILES) {
      if (truncated) break;
      const absolute = join(root, candidate.path);
      try {
        if (!existsSync(absolute) || !statSync(absolute).isFile() || !isPathSafe(absolute, [root])) continue;
      } catch { continue; }
      // index_skills explicit roots are directories, so this has no actionable indexRoot.
      add({ ...candidate, indexable: false, kind: 'instruction_file', matchedBy: 'root_instruction_file' });
    }
  }
  return { scope, root, candidates, truncated };
}

export const candidateDiscoveryDefaults = { maxDepth: DEFAULT_MAX_DEPTH, limit: DEFAULT_LIMIT, scanEntryLimit: DEFAULT_SCAN_ENTRY_LIMIT };
