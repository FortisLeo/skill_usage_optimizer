import { existsSync, lstatSync, opendirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { SourceSystem } from '../types.js';
import { isPathSafe, resolveRealpath, validateRoot } from '../fs/roots.js';

export type DiscoveryScope = 'project' | 'home';
export type CandidateKind = 'skill_file' | 'skill_directory' | 'rule_directory' | 'instruction_file' | 'configuration_file';

export interface SkillCandidate {
  path: string;
  system: SourceSystem;
  indexable: boolean;
  indexRoot?: string;
  kind: CandidateKind;
  matchedBy: 'SKILL.md' | 'skill.md' | 'known_harness_path' | 'skills_directory' | 'root_instruction_file' | 'known_config_path';
}

export interface CandidateDiscoveryResult {
  scope: DiscoveryScope;
  root: string;
  candidates: SkillCandidate[];
  truncated: boolean;
}

const PROJECT_EXCLUDED = new Set(['.git', '.cache', '.skill-cache', '.next', 'node_modules', 'cache', 'caches', 'coverage', 'Library', 'Downloads', 'Trash', 'Caches', 'vendor', 'dist', 'build', 'target']);
const HOME_TECHNICAL_EXCLUDED = new Set(['.git', '.cache', '.skill-cache', '.next', 'node_modules', 'cache', 'caches', 'coverage', 'Caches', 'vendor', 'dist', 'build', 'target']);
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
  { path: '.claude/rules', system: 'claude', kind: 'rule_directory' },
  { path: '.opencode/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.opencode/skill', system: 'opencode', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'codex', kind: 'skill_directory' },
  { path: '.github/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.github/copilot', system: 'copilot', kind: 'skill_directory' },
  { path: '.github/instructions', system: 'copilot', kind: 'rule_directory' },
  { path: '.claude/rules', system: 'copilot', kind: 'rule_directory' },
  { path: '.github/prompts', system: 'copilot', kind: 'instruction_file' },
  { path: '.github/agents', system: 'copilot', kind: 'instruction_file' },
  { path: '.claude/agents', system: 'copilot', kind: 'instruction_file' },
  { path: '.cursor/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.codex/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.cursor/rules', system: 'cursor', kind: 'rule_directory' },
  { path: '.gemini/skills', system: 'gemini', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'gemini', kind: 'skill_directory' },
  { path: '.devin/rules', system: 'windsurf', kind: 'rule_directory' },
  { path: '.windsurf/rules', system: 'windsurf', kind: 'rule_directory' },
  { path: '.cline/skills', system: 'cline', kind: 'skill_directory' },
  { path: '.clinerules/skills', system: 'cline', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'cline', kind: 'skill_directory' },
  { path: '.cline/rules', system: 'cline', kind: 'rule_directory' },
  { path: '.clinerules', system: 'cline', kind: 'rule_directory' },
  { path: '.roo/skills', system: 'roo', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'roo', kind: 'skill_directory' },
  { path: '.roo/rules', system: 'roo', kind: 'rule_directory' },
  { path: '.continue/rules', system: 'continue', kind: 'rule_directory' }
];

const HOME_ROOTS: Array<{ path: string; system: SourceSystem; kind: CandidateKind }> = [
  { path: '.claude/skills', system: 'claude', kind: 'skill_directory' },
  { path: '.claude/commands', system: 'claude', kind: 'skill_directory' },
  { path: '.claude/rules', system: 'claude', kind: 'rule_directory' },
  { path: '.config/opencode/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.config/opencode/skill', system: 'opencode', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'opencode', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'codex', kind: 'skill_directory' },
  { path: '.copilot/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'copilot', kind: 'skill_directory' },
  { path: '.github/copilot', system: 'copilot', kind: 'skill_directory' },
  { path: '.copilot/instructions', system: 'copilot', kind: 'rule_directory' },
  { path: '.claude/rules', system: 'copilot', kind: 'rule_directory' },
  { path: '.copilot/agents', system: 'copilot', kind: 'instruction_file' },
  { path: '.cursor/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.claude/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.codex/skills', system: 'cursor', kind: 'skill_directory' },
  { path: '.gemini/skills', system: 'gemini', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'gemini', kind: 'skill_directory' },
  { path: '.cline/skills', system: 'cline', kind: 'skill_directory' },
  { path: '.cline/rules', system: 'cline', kind: 'rule_directory' },
  { path: 'Documents/Cline/Rules', system: 'cline', kind: 'rule_directory' },
  { path: '.roo/skills', system: 'roo', kind: 'skill_directory' },
  { path: '.agents/skills', system: 'roo', kind: 'skill_directory' },
  { path: '.roo/rules', system: 'roo', kind: 'rule_directory' }
];
const KNOWN_ROOT_PATHS = new Set([...PROJECT_ROOTS, ...HOME_ROOTS].map(candidate => candidate.path));

const PROJECT_INSTRUCTION_FILES: Array<{ path: string; system: SourceSystem }> = [
  { path: 'CLAUDE.md', system: 'claude' },
  { path: 'CLAUDE.local.md', system: 'claude' },
  { path: '.claude/CLAUDE.md', system: 'claude' },
  { path: 'AGENTS.md', system: 'opencode' },
  { path: 'AGENTS.md', system: 'codex' },
  { path: 'CLAUDE.md', system: 'opencode' },
  { path: '.github/copilot-instructions.md', system: 'copilot' },
  { path: 'AGENTS.md', system: 'copilot' },
  { path: 'CLAUDE.md', system: 'copilot' },
  { path: 'CLAUDE.local.md', system: 'copilot' },
  { path: '.claude/CLAUDE.md', system: 'copilot' },
  { path: 'AGENTS.md', system: 'cursor' },
  { path: 'CLAUDE.md', system: 'cursor' },
  { path: '.cursorrules', system: 'cursor' },
  { path: 'GEMINI.md', system: 'gemini' },
  { path: 'AGENTS.md', system: 'windsurf' },
  { path: '.windsurfrules', system: 'windsurf' },
  { path: '.clinerules', system: 'cline' },
  { path: 'AGENTS.md', system: 'cline' },
  { path: '.cursorrules', system: 'cline' },
  { path: '.windsurfrules', system: 'cline' },
  { path: 'AGENTS.md', system: 'roo' },
  { path: 'AGENT.md', system: 'roo' },
  { path: '.roorules', system: 'roo' }
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
    let key = `${candidate.system}:${candidate.path}`;
    if (candidate.indexRoot) {
      try { key = `${candidate.system}:${resolveRealpath(candidate.indexRoot)}`; } catch { key = `${candidate.system}:${candidate.indexRoot}`; }
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

  const walkRoot = (dir: string, system: SourceSystem | undefined, depth: number, dedicated = false) => {
    if (truncated || depth > maxDepth || !isPathSafe(dir, [root])) return;
    let real: string;
    try { real = resolveRealpath(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    try {
      const handle = opendirSync(dir);
      try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (scannedEntries >= scanEntryLimit) {
          truncated = true;
          return;
        }
        scannedEntries++;
        const absolute = join(dir, entry.name);
        const relativePath = normalizeRelativePath(relative(root, absolute));
        const dedicatedHiddenPath = isDedicatedHiddenCandidatePath(relativePath);
        const excluded = scope === 'project'
          ? PROJECT_EXCLUDED.has(entry.name)
          : HOME_TECHNICAL_EXCLUDED.has(entry.name)
            || HOME_TOP_LEVEL_EXCLUDED.has(relativePath)
            || HOME_PLATFORM_EXCLUDED[platform].has(relativePath)
            || (!dedicated && entry.isDirectory() && entry.name.startsWith('.') && !dedicatedHiddenPath)
            || (!dedicated && isDedicatedHiddenParent(relativePath) && !dedicatedHiddenPath)
            || relativePath === '.claude/plugins'
            || (platform === 'linux' && relativePath === '.local/share/Trash');
        if (truncated || entry.isSymbolicLink() || excluded) continue;
        if (!isPathSafe(absolute, [root])) continue;
        if (entry.isFile() && (entry.name === 'CLAUDE.md' || entry.name === 'CLAUDE.local.md')) {
          add({ path: relativePath, system: 'claude', indexable: false, kind: 'instruction_file', matchedBy: 'root_instruction_file' });
        } else if (scope === 'project' && entry.isFile() && (entry.name === 'AGENTS.md' || entry.name === 'agents.md')) {
          add({ path: relativePath, system: 'windsurf', indexable: false, kind: 'instruction_file', matchedBy: 'root_instruction_file' });
        } else if (scope === 'project' && entry.isFile() && entry.name.startsWith('.roorules-')) {
          add({ path: relativePath, system: 'roo', indexable: false, kind: 'instruction_file', matchedBy: 'root_instruction_file' });
        } else if (system && entry.isFile() && (entry.name === 'SKILL.md' || entry.name === 'skill.md')) {
          add({ path: normalizeRelativePath(relative(root, absolute)), system, indexable: true, indexRoot: dirname(absolute), kind: 'skill_file', matchedBy: entry.name });
        } else if (entry.isDirectory() && depth < maxDepth) {
          let childSystem = system;
          const rooModeRoot = /^(?:\.roo\/(?:skills|rules)-[^/]+|\.agents\/skills-[^/]+)$/.test(relativePath);
          if (rooModeRoot) {
            childSystem = 'roo';
            add({ path: relativePath, system: 'roo', indexable: true, indexRoot: absolute, kind: entry.name.startsWith('rules-') ? 'rule_directory' : 'skill_directory', matchedBy: 'known_harness_path' });
            continue;
          } else if (entry.name === 'skills') {
            const path = normalizeRelativePath(relative(root, absolute));
            const known = (scope === 'project' ? PROJECT_ROOTS : HOME_ROOTS).find(candidate => candidate.path === path);
            if (!known && KNOWN_ROOT_PATHS.has(path)) continue;
            const parentPath = normalizeRelativePath(dirname(path));
            const nestedClaude = scope === 'project' && (parentPath === '.claude' || parentPath.endsWith('/.claude'));
            const geminiExtensionPath = scope === 'home' && /^\.gemini\/extensions\/[^/]+\/skills$/.test(path);
            const geminiExtension = geminiExtensionPath && hasRegularFile(join(dirname(absolute), 'gemini-extension.json'));
            if (geminiExtensionPath && !geminiExtension) continue;
            childSystem = known?.system ?? (nestedClaude ? 'claude' : geminiExtension ? 'gemini' : 'generic');
            if (!known) add({ path, system: childSystem, indexable: true, indexRoot: absolute, kind: 'skill_directory', matchedBy: nestedClaude ? 'known_harness_path' : 'skills_directory' });
          }
          walkRoot(absolute, childSystem, depth + 1, dedicated);
        }
      }
      } finally { handle.closeSync(); }
    } catch { /* inaccessible directories are not candidates */ }
  };

  for (const candidate of scope === 'project' ? PROJECT_ROOTS : HOME_ROOTS) {
    if (truncated) break;
    const absolute = join(root, candidate.path);
    try {
      if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory() || !isPathSafe(absolute, [root])) continue;
    } catch { continue; }
    if (!add({ ...candidate, indexable: true, indexRoot: absolute, matchedBy: 'known_harness_path' })) continue;
    walkRoot(absolute, candidate.system, 0, true);
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
    const aiderConfig = join(root, '.aider.conf.yml');
    if (hasRegularFile(aiderConfig) && isPathSafe(aiderConfig, [root])) {
      add({ path: '.aider.conf.yml', system: 'aider', indexable: false, kind: 'configuration_file', matchedBy: 'known_config_path' });
    }
  } else {
    const path = '.codeium/windsurf/memories/global_rules.md';
    const absolute = join(root, path);
    try {
      if (existsSync(absolute) && !lstatSync(absolute).isSymbolicLink() && statSync(absolute).isFile() && isPathSafe(absolute, [root])) {
        add({ path, system: 'windsurf', indexable: false, kind: 'instruction_file', matchedBy: 'root_instruction_file' });
      }
    } catch { /* inaccessible global rule is not a candidate */ }
    const aiderConfig = join(root, '.aider.conf.yml');
    if (hasRegularFile(aiderConfig) && isPathSafe(aiderConfig, [root])) {
      add({ path: '.aider.conf.yml', system: 'aider', indexable: false, kind: 'configuration_file', matchedBy: 'known_config_path' });
    }
  }
  return { scope, root, candidates, truncated };
}

export const candidateDiscoveryDefaults = { maxDepth: DEFAULT_MAX_DEPTH, limit: DEFAULT_LIMIT, scanEntryLimit: DEFAULT_SCAN_ENTRY_LIMIT };

function hasRegularFile(path: string): boolean {
  try { return existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isFile(); } catch { return false; }
}

const isDedicatedHiddenParent = (path: string) => /^(?:\.gemini|\.roo|\.agents)(?:\/|$)/.test(path);

const isDedicatedHiddenCandidatePath = (path: string) =>
  path === '.gemini'
  || path === '.gemini/extensions'
  || /^\.gemini\/extensions\/[^/]+(?:\/skills(?:\/[^/]+)*)?$/.test(path)
  || path === '.roo'
  || /^\.roo\/(?:skills|rules)-[^/]+(?:\/[^/]+)*$/.test(path)
  || path === '.agents'
  || /^\.agents\/skills-[^/]+(?:\/[^/]+)*$/.test(path);
