import type { DiscoveryContext, SourceSystem } from './types.js';

export const DEFAULT_SKILL_DIRS: Record<SourceSystem, string[]> = {
  claude: ['.claude/skills', '.claude/commands'],
  opencode: ['.opencode/skills', '.opencode/rules'],
  codex: ['.codex/skills', '.codex/agents'],
  copilot: ['.github/copilot', '.github/instructions']
};

export const GLOBAL_SKILL_DIRS: Record<SourceSystem, string[]> = {
  claude: ['.claude/skills'],
  opencode: ['.opencode/skills', '.config/opencode/skills'],
  codex: ['.codex/skills'],
  copilot: ['.github/copilot']
};

export const CODEX_SYSTEM_SKILLS_DIR = '/etc/codex/skills';

export const PRECEDENCE: Record<string, number> = {
  workspace_repo: 100,
  workspace_root: 80,
  explicit: 70,
  global: 40,
  system: 10
};

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
const SKILL_ENTRY_NAMES = new Set(['skill.md', 'instructions.md', 'rules.md', 'SKILL.md']);

export function isSkillFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function isSkillEntry(name: string): boolean {
  return SKILL_ENTRY_NAMES.has(name);
}

export function defaultContext(homeDir: string): DiscoveryContext {
  return {
    workspaceRoot: '',
    repoRoot: null,
    homeDir,
    includeGlobals: true,
    includeSystem: false,
    explicitRoots: []
  };
}
