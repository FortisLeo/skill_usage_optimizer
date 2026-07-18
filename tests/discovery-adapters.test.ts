import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover } from '../src/discovery/index.js';
import { discoverSkillFolders } from '../src/discovery/candidates.js';
import { normalize } from '../src/normalize/index.js';
import { compile } from '../src/compiler/index.js';
import { loadContext } from '../src/retrieval/context.js';
import { FileStore } from '../src/store/fileStore.js';
import { handleIndexSkills, handleListSkills } from '../src/mcp/tools.js';
import { createScanBudget, scannerLimits } from '../src/discovery/shared.js';
import { discoverRoo } from '../src/discovery/roo.js';
import { discoverWindsurf } from '../src/discovery/windsurf.js';
import { validateIndexSkillsArgs, validateListSkillsArgs } from '../src/mcp/schemas.js';
import { TOOL_DEFS } from '../src/mcp/server.js';
import { makeTempWorkspace, writeFixture } from './testUtils.js';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'discovery');
const opencodeFixtureRoot = join(fixturesRoot, 'opencode');
const claudeFixtureRoot = join(fixturesRoot, 'claude');
const codexFixtureRoot = join(fixturesRoot, 'codex');
const copilotFixtureRoot = join(fixturesRoot, 'copilot');
const cursorFixtureRoot = join(fixturesRoot, 'cursor');
const geminiFixtureRoot = join(fixturesRoot, 'gemini');
const clineFixtureRoot = join(fixturesRoot, 'cline');
const rooFixtureRoot = join(fixturesRoot, 'roo');
const continueFixtureRoot = join(fixturesRoot, 'continue');
const windsurfFixtureRoot = join(fixturesRoot, 'windsurf');
const aiderFixtureRoot = join(fixturesRoot, 'aider');

describe('Claude Code documented-roots adapter', () => {
  it('claude: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'claude-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const ctx = {
      workspaceRoot: join(claudeFixtureRoot, 'project'), repoRoot: null,
      homeDir: join(claudeFixtureRoot, 'home'), includeGlobals: true, includeSystem: false,
      explicitRoots: [explicit], explicitRootSystem: 'claude' as const, requestedSystem: 'claude' as const
    };
    const expected: Array<[string, string]> = [
      ['.claude/skills/project-skill/SKILL.md', 'skill_package'],
      ['.claude/commands/deploy.md', 'instruction_file'],
      ['.claude/commands/team/release.md', 'instruction_file'],
      ['.claude/rules/security.md', 'rule_file'],
      ['.claude/rules/frontend/style.md', 'rule_file'],
      ['CLAUDE.md', 'instruction_file'],
      ['.claude/CLAUDE.md', 'instruction_file'],
      ['packages/web/CLAUDE.md', 'instruction_file'],
      ['packages/web/CLAUDE.local.md', 'instruction_file'],
      ['packages/web/.claude/skills/nested-skill/SKILL.md', 'skill_package']
    ];
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'claude')).toBe(true);
      for (const [path, kind] of expected) {
        expect(result.artifacts).toContainEqual(expect.objectContaining({ relativePath: path, kind }));
      }
      for (const suffix of ['.claude/skills/global-skill/SKILL.md', '.claude/commands/global.md', '.claude/rules/preferences.md', '.claude/CLAUDE.md']) {
        expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      }
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
      expect(JSON.stringify(result.artifacts)).not.toContain('plugins/cache');
      expect(result.artifacts.some(artifact => artifact.relativePath === 'AGENTS.md')).toBe(false);
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('claude: absent and unsupported sources diagnose without failing', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'claude';
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'claude', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'claude', capability: 'configuration', sourceType: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
    } finally { cleanup(); }
  });

  it('claude: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const skills = join(root, '.claude', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'claude-outside-'));
    ctx.requestedSystem = 'claude';
    writeFixture(root, '.claude/skills/safe/SKILL.md', '# Safe');
    writeFixture(root, '.claude/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFixture(root, '.claude/skills/oversized/SKILL.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'claude', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2 }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('claude: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'claude';
    writeFixture(root, '.claude/skills/shared/SKILL.md', '# Workspace');
    writeFixture(repo, '.claude/skills/shared/SKILL.md', '# Repo');
    writeFixture(root, 'CLAUDE.md', '# Workspace instructions');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(repo, '.claude/skills/shared/SKILL.md'))?.precedence).toBe(100);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.claude/skills/shared/SKILL.md'))?.precedence).toBe(80);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('claude: candidates include confirmed project global and nested roots', () => {
    const projectCandidates = discoverSkillFolders(join(claudeFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(claudeFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.claude/skills', system: 'claude' }),
      expect.objectContaining({ path: '.claude/commands', system: 'claude' }),
      expect.objectContaining({ path: '.claude/rules', system: 'claude' }),
      expect.objectContaining({ path: 'packages/web/.claude/skills', system: 'claude' }),
      expect.objectContaining({ path: 'packages/web/CLAUDE.md', system: 'claude', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.claude/skills', system: 'claude' }),
      expect.objectContaining({ path: '.claude/commands', system: 'claude' }),
      expect.objectContaining({ path: '.claude/rules', system: 'claude' })
    ]));
    expect(JSON.stringify(homeCandidates)).not.toContain('plugins/cache');
  });

  it('claude: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'claude-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const response = JSON.parse(await handleIndexSkills({
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(claudeFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(claudeFixtureRoot, 'project')
      }, 'claude'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'claude')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('packages/web/.claude/skills/nested-skill/SKILL.md'))).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('OpenCode documented-roots adapter', () => {
  it('opencode: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'opencode-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const ctx = {
      workspaceRoot: join(opencodeFixtureRoot, 'project'), repoRoot: null,
      homeDir: join(opencodeFixtureRoot, 'home'), includeGlobals: true, includeSystem: false,
      explicitRoots: [explicit], explicitRootSystem: 'opencode' as const, requestedSystem: 'opencode' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'opencode')).toBe(true);
      expect(result.artifacts.map(artifact => artifact.relativePath)).toEqual(expect.arrayContaining([
        '.opencode/skills/project-skill/SKILL.md', '.agents/skills/agent-compatible/SKILL.md',
        '.claude/skills/claude-compatible/SKILL.md', '.opencode/skill/singular-project/SKILL.md', 'AGENTS.md'
      ]));
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.config/opencode/skills/global-skill/SKILL.md'))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.config/opencode/skill/singular-global/SKILL.md'))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.agents/skills/global-agent-compatible/SKILL.md'))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.claude/skills/global-claude-compatible/SKILL.md'))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath === join(explicit, 'explicit.md') && artifact.precedence === 70)).toBe(true);
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('opencode: absent and unsupported sources diagnose without failing', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'opencode';
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'opencode', capability: 'roots', sourceType: 'roots', status: 'unavailable', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'opencode', capability: 'runtime_bridge', sourceType: 'runtime', status: 'unavailable', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(result.discoveryDiagnostics?.every(item => item.explicitRootGuidance === 'Pass trusted directories in index_skills.roots.')).toBe(true);
    } finally { cleanup(); }
  });

  it('opencode: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'opencode';
    const skills = join(root, '.opencode', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'opencode-outside-'));
    writeFileSync(join(outside, 'SKILL.md'), '# escaped');
    mkdirSync(join(skills, 'safe'), { recursive: true });
    writeFileSync(join(skills, 'safe', 'SKILL.md'), '# safe');
    mkdirSync(join(skills, 'node_modules', 'cached'), { recursive: true });
    writeFileSync(join(skills, 'node_modules', 'cached', 'SKILL.md'), '# cached');
    mkdirSync(join(skills, 'oversized'), { recursive: true });
    writeFileSync(join(skills, 'oversized', 'SKILL.md'), Buffer.alloc(scannerLimits.fileBytes + 1));
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'opencode', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2 }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('opencode: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'opencode';
    writeFixture(root, '.opencode/skills/shared/SKILL.md', '# Workspace');
    writeFixture(repo, '.opencode/skills/shared/SKILL.md', '# Repo');
    writeFixture(root, 'AGENTS.md', '# Agents wins');
    writeFixture(root, 'CLAUDE.md', '# Claude fallback');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(repo, '.opencode/skills/shared/SKILL.md'))?.precedence).toBe(100);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.opencode/skills/shared/SKILL.md'))?.precedence).toBe(80);
      expect(result.artifacts.some(artifact => artifact.absolutePath === join(root, 'AGENTS.md'))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath === join(root, 'CLAUDE.md'))).toBe(false);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('opencode: uses valid CLAUDE.md when preferred AGENTS.md is invalid', () => {
    for (const kind of ['directory', 'symlink', 'oversized'] as const) {
      const { root, ctx, cleanup } = makeTempWorkspace();
      const outside = mkdtempSync(join(tmpdir(), 'opencode-agents-fallback-'));
      ctx.requestedSystem = 'opencode';
      writeFixture(root, 'CLAUDE.md', '# Valid fallback');
      if (kind === 'directory') mkdirSync(join(root, 'AGENTS.md'));
      else if (kind === 'symlink') {
        writeFileSync(join(outside, 'AGENTS.md'), '# linked');
        symlinkSync(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'));
      } else writeFileSync(join(root, 'AGENTS.md'), Buffer.alloc(scannerLimits.fileBytes + 1));
      try {
        const artifacts = discover(ctx).artifacts;
        expect(artifacts.some(artifact => artifact.absolutePath === join(root, 'AGENTS.md'))).toBe(false);
        expect(artifacts.some(artifact => artifact.absolutePath === join(root, 'CLAUDE.md'))).toBe(true);
      } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
    }
  });

  it('classifies a workspace nested in its repository before the repository boundary', () => {
    const repo = mkdtempSync(join(tmpdir(), 'opencode-nested-repo-'));
    const workspace = join(repo, 'packages', 'app');
    const home = mkdtempSync(join(tmpdir(), 'opencode-nested-home-'));
    mkdirSync(workspace, { recursive: true });
    writeFixture(repo, '.opencode/skills/repo-only/SKILL.md', '# Repo');
    writeFixture(workspace, '.opencode/skills/workspace/SKILL.md', '# Workspace');
    try {
      const artifacts = discover({ workspaceRoot: workspace, repoRoot: repo, homeDir: home, includeGlobals: false, includeSystem: false, explicitRoots: [], requestedSystem: 'opencode' }).artifacts;
      expect(artifacts.find(artifact => artifact.absolutePath === join(workspace, '.opencode/skills/workspace/SKILL.md'))?.precedence).toBe(80);
      expect(artifacts.find(artifact => artifact.absolutePath === join(repo, '.opencode/skills/repo-only/SKILL.md'))?.precedence).toBe(100);
    } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('opencode: remains roots-only without shipped writer and reader', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'opencode';
    writeFixture(root, '.opencode/rules/unsupported.md', '# Unsupported');
    writeFixture(root, 'docs/configured.md', '# Configured');
    writeFixture(root, 'opencode.json', '{"instructions":["docs/configured.md"]}');
    writeFixture(ctx.homeDir, '.cache/opencode/node_modules/plugin/SKILL.md', '# Cached');
    try {
      const result = discover(ctx);
      expect(result.artifacts).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('.cache/opencode');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'runtime_bridge', code: 'SOURCE_UNSUPPORTED' }));
    } finally { cleanup(); }
  });

  it('opencode: candidates include only confirmed automatic roots with OpenCode attribution', () => {
    const project = join(opencodeFixtureRoot, 'project');
    const projectCandidates = discoverSkillFolders(project).candidates;
    const homeCandidates = discoverSkillFolders(join(opencodeFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.opencode/skills', system: 'opencode' }),
      expect.objectContaining({ path: '.agents/skills', system: 'opencode' }),
      expect.objectContaining({ path: '.claude/skills', system: 'opencode' }),
      expect.objectContaining({ path: 'AGENTS.md', system: 'opencode', indexable: false })
    ]));
    expect(homeCandidates).toContainEqual(expect.objectContaining({ path: '.config/opencode/skills', system: 'opencode' }));
    expect(projectCandidates.some(candidate => candidate.path === '.opencode/rules')).toBe(false);
  });

  it('opencode: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'opencode-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const response = JSON.parse(await handleIndexSkills({
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(opencodeFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(opencodeFixtureRoot, 'project')
      }, 'opencode'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'runtime_bridge', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'opencode')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.claude/skills/claude-compatible/SKILL.md'))).toBe(true);
      const index = await store.readIndex();
      expect((await store.readSections(Object.keys(index))).size).toBe(Object.keys(index).length);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('GitHub Copilot and VS Code documented-roots adapter', () => {
  it('copilot: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'copilot-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const ctx = {
      workspaceRoot: join(copilotFixtureRoot, 'project'), repoRoot: null,
      homeDir: join(copilotFixtureRoot, 'home'), includeGlobals: true, includeSystem: false,
      explicitRoots: [explicit], explicitRootSystem: 'copilot' as const, requestedSystem: 'copilot' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'copilot')).toBe(true);
      for (const path of [
        '.github/copilot-instructions.md', '.github/instructions/typescript.instructions.md',
        '.github/skills/review/SKILL.md', '.claude/skills/compatible/SKILL.md',
        '.agents/skills/portable/SKILL.md', '.github/prompts/review.prompt.md',
        '.github/agents/security.agent.md', '.claude/agents/compat.md',
        '.claude/rules/testing.instructions.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'
      ]) expect(result.artifacts).toContainEqual(expect.objectContaining({ relativePath: path }));
      for (const suffix of [
        '.copilot/skills/global/SKILL.md', '.copilot/instructions/global.instructions.md',
        '.copilot/agents/global.agent.md', '.claude/CLAUDE.md'
      ]) expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('copilot: instruction scopes keep verified precedence', () => {
    const project = join(copilotFixtureRoot, 'project');
    const ctx = { workspaceRoot: project, repoRoot: project, homeDir: join(copilotFixtureRoot, 'home'), includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'copilot' as const };
    const result = discover(ctx);
    const normalized = normalize(result.artifacts, ctx);
    const scoped = normalized.inputs.find(input => input.sourcePath.endsWith('typescript.instructions.md'));
    expect(scoped?.frontmatter.applyTo).toBe('**/*.ts,**/*.tsx');
    expect(scoped?.precedence).toBe(100);
    expect(result.artifacts.find(artifact => artifact.absolutePath.endsWith('.copilot/instructions/global.instructions.md'))?.precedence).toBe(40);
  });

  it('copilot: absent and unsupported sources diagnose without failing', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'copilot';
    writeFixture(root, '.github/copilot-unsupported/legacy.md', '# Unsupported root');
    writeFixture(ctx.homeDir, '.vscode/user-data/prompts/profile.prompt.md', '# Profile-managed');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'copilot', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'copilot', capability: 'configuration', sourceType: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('copilot: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const skills = join(root, '.github', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'copilot-outside-'));
    ctx.requestedSystem = 'copilot';
    writeFixture(root, '.github/skills/safe/SKILL.md', '# Safe');
    writeFixture(root, '.github/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFixture(root, '.github/skills/oversized/SKILL.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'copilot', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2 }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('copilot: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'copilot';
    writeFixture(root, '.github/skills/workspace/SKILL.md', '# Workspace');
    writeFixture(repo, '.github/skills/repository/SKILL.md', '# Repository');
    try {
      const result = discover(ctx);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(repo, '.github/skills/repository/SKILL.md'))?.precedence).toBe(100);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.github/skills/workspace/SKILL.md'))?.precedence).toBe(80);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('copilot: candidates include only confirmed automatic roots', () => {
    const projectCandidates = discoverSkillFolders(join(copilotFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(copilotFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.github/skills', system: 'copilot' }),
      expect.objectContaining({ path: '.github/instructions', system: 'copilot' }),
      expect.objectContaining({ path: '.github/prompts', system: 'copilot' }),
      expect.objectContaining({ path: '.github/agents', system: 'copilot' }),
      expect.objectContaining({ path: 'AGENTS.md', system: 'copilot', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.copilot/skills', system: 'copilot' }),
      expect.objectContaining({ path: '.copilot/instructions', system: 'copilot' }),
      expect.objectContaining({ path: '.copilot/agents', system: 'copilot' })
    ]));
    expect(projectCandidates.some(candidate => candidate.path === '.github/copilot')).toBe(false);
  });

  it('copilot: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'copilot-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const response = JSON.parse(await handleIndexSkills({
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(copilotFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(copilotFixtureRoot, 'project')
      }, 'copilot'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'copilot')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.github/prompts/review.prompt.md'))).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Codex CLI documented-roots/config adapter', () => {
  it('codex: documented roots and agents', () => {
    const project = join(codexFixtureRoot, 'project');
    const workspace = join(project, 'packages', 'web');
    const result = discover({
      workspaceRoot: workspace, repoRoot: project, homeDir: join(codexFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'codex'
    });
    expect(result.errors).toEqual([]);
    expect(result.artifacts.every(artifact => artifact.system === 'codex')).toBe(true);
    for (const path of [
      join(project, 'AGENTS.md'),
      join(project, '.agents/skills/project-skill/SKILL.md'),
      join(project, '.codex/agents/reviewer.toml'),
      join(workspace, 'AGENTS.override.md'),
      join(workspace, '.agents/skills/web-skill/SKILL.md'),
      join(workspace, '.codex/agents/web.toml'),
      join(codexFixtureRoot, 'home/.codex/AGENTS.override.md'),
      join(codexFixtureRoot, 'home/.agents/skills/global-skill/SKILL.md'),
      join(codexFixtureRoot, 'home/.codex/agents/global.toml')
    ]) expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: path }));
  });

  it('codex: AGENTS.md hierarchy and precedence', () => {
    const project = join(codexFixtureRoot, 'project');
    const workspace = join(project, 'packages', 'web');
    const result = discover({
      workspaceRoot: workspace, repoRoot: project, homeDir: join(codexFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'codex'
    });
    expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(project, 'AGENTS.md'), precedence: 100 }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(workspace, 'AGENTS.override.md'), precedence: 80 }));
    expect(result.artifacts.some(artifact => artifact.absolutePath === join(workspace, 'AGENTS.md'))).toBe(false);
    expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('home/.codex/AGENTS.md'))).toBe(false);
    expect(result.artifacts.find(artifact => artifact.absolutePath.endsWith('home/.codex/AGENTS.override.md'))?.precedence).toBe(40);
  });

  it('codex: absent and unsupported sources diagnose without failing', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'codex';
    writeFixture(root, '.codex/config.toml', 'project_doc_fallback_filenames = ["TEAM.md"]');
    writeFixture(root, '.codex/skills/unsupported/SKILL.md', '# Unsupported old root');
    writeFixture(ctx.homeDir, '.codex/plugins/example/SKILL.md', '# Plugin');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'codex', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'codex', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(result.discoveryDiagnostics?.every(item => item.explicitRootGuidance === 'Pass trusted directories in index_skills.roots.')).toBe(true);
    } finally { cleanup(); }
  });

  it('codex: system root requires verified includeSystem', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    const system = mkdtempSync(join(tmpdir(), 'codex-system-'));
    writeFixture(system, 'admin/SKILL.md', '# Admin');
    ctx.requestedSystem = 'codex';
    ctx.codexSystemRoot = system;
    try {
      expect(discover(ctx).artifacts.some(artifact => artifact.absolutePath.endsWith('admin/SKILL.md'))).toBe(false);
      ctx.includeSystem = true;
      expect(discover(ctx).artifacts).toContainEqual(expect.objectContaining({
        absolutePath: join(system, 'admin/SKILL.md'), system: 'codex', precedence: 10
      }));
    } finally { cleanup(); rmSync(system, { recursive: true, force: true }); }
  });

  it('codex: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const skills = join(root, '.agents', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    ctx.requestedSystem = 'codex';
    writeFixture(root, '.agents/skills/safe/SKILL.md', '# Safe');
    writeFixture(root, '.agents/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFixture(root, '.agents/skills/oversized/SKILL.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'codex', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2 }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('codex: explicit roots preserve attribution and precedence', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    const explicit = mkdtempSync(join(tmpdir(), 'codex-explicit-'));
    writeFileSync(join(explicit, 'custom.md'), '# Custom');
    ctx.requestedSystem = 'codex';
    ctx.explicitRoots = [explicit];
    ctx.explicitRootSystem = 'codex';
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'custom.md'), system: 'codex', precedence: 70 }));
    } finally { cleanup(); rmSync(explicit, { recursive: true, force: true }); }
  });

  it('codex: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'codex';
    writeFixture(root, '.agents/skills/workspace/SKILL.md', '# Workspace');
    writeFixture(repo, '.agents/skills/repository/SKILL.md', '# Repository');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.find(artifact => artifact.absolutePath.includes('/repo/'))?.precedence).toBe(100);
      expect(result.artifacts.find(artifact => artifact.absolutePath.includes('/workspace/'))?.precedence).toBe(80);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('codex: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'codex-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const response = JSON.parse(await handleIndexSkills({
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(codexFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(codexFixtureRoot, 'project')
      }, 'codex'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'codex')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.codex/agents/reviewer.toml'))).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Cursor documented-roots adapter', () => {
  it('cursor: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'cursor-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const project = join(cursorFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: null, homeDir: join(cursorFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'cursor' as const, requestedSystem: 'cursor' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'cursor')).toBe(true);
      for (const suffix of [
        '.cursor/rules/always.mdc', '.cursor/rules/frontend/component.mdc',
        '.cursor/skills/native/SKILL.md', '.agents/skills/portable/SKILL.md',
        '.claude/skills/claude-compatible/SKILL.md', '.codex/skills/codex-compatible/SKILL.md',
        'AGENTS.md', 'CLAUDE.md', '.cursorrules',
        '.cursor/skills/user-native/SKILL.md', '.agents/skills/user-portable/SKILL.md',
        '.claude/skills/user-claude/SKILL.md', '.codex/skills/user-codex/SKILL.md'
      ]) expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
      expect(JSON.stringify(result.artifacts)).not.toContain('.cursor/commands');
      expect(JSON.stringify(result.artifacts)).not.toContain('ignored-user-rule');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'cursor', capability: 'configuration', code: 'SOURCE_UNSUPPORTED'
      }));

      const normalized = normalize(result.artifacts, ctx).inputs;
      expect(normalized.find(input => input.sourcePath.endsWith('component.mdc'))?.frontmatter).toMatchObject({
        description: 'React component conventions', globs: 'src/components/**/*.tsx', alwaysApply: false
      });
      expect(normalized.find(input => input.sourcePath.endsWith('.cursor/skills/native/SKILL.md'))?.frontmatter.paths).toEqual(['src/**/*.ts']);
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('cursor: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const rules = join(root, '.cursor', 'rules');
    const outside = mkdtempSync(join(tmpdir(), 'cursor-outside-'));
    ctx.requestedSystem = 'cursor';
    writeFixture(root, '.cursor/rules/safe.mdc', '# Safe');
    writeFixture(root, '.cursor/rules/oversized.mdc', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFixture(root, '.cursor/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFileSync(join(outside, 'escaped.mdc'), '# Escaped');
    symlinkSync(outside, join(rules, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(rules, 'safe.mdc')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'cursor', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2
      }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('cursor: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'cursor';
    writeFixture(root, '.cursor/skills/shared/SKILL.md', '# Workspace');
    writeFixture(repo, '.cursor/skills/shared/SKILL.md', '# Repository');
    try {
      const result = discover(ctx);
      const compiled = compile(normalize(result.artifacts, ctx).inputs, ctx);
      expect(result.errors).toEqual([]);
      expect(compiled.manifests?.find(manifest => manifest.skillName === 'shared')).toMatchObject({
        system: 'cursor', sourcePath: join(repo, '.cursor/skills/shared/SKILL.md'), precedence: 100
      });
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('cursor: absent and unsupported sources diagnose without unstable state crawling', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'cursor';
    writeFixture(ctx.homeDir, '.cursor/rules/private.mdc', '# Private');
    writeFixture(ctx.homeDir, '.cursor/commands/private.md', '# Command');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'cursor', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'cursor', capability: 'configuration', sourceType: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('private.mdc');
    } finally { cleanup(); }
  });

  it('cursor: candidates include only confirmed project and user roots', () => {
    const projectCandidates = discoverSkillFolders(join(cursorFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(cursorFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.cursor/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.agents/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.claude/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.codex/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.cursor/rules', system: 'cursor' }),
      expect.objectContaining({ path: '.cursorrules', system: 'cursor', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.cursor/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.agents/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.claude/skills', system: 'cursor' }),
      expect.objectContaining({ path: '.codex/skills', system: 'cursor' })
    ]));
    expect(homeCandidates.some(candidate => candidate.path === '.cursor/rules' && candidate.system === 'cursor')).toBe(false);
    expect(JSON.stringify([...projectCandidates, ...homeCandidates])).not.toContain('.cursor/commands');
  });

  it('cursor: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'cursor-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(cursorFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(cursorFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'cursor'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'cursor')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.cursorrules'))).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'cursor'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'cursor')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Gemini CLI documented-roots adapter', () => {
  it('gemini: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'gemini-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const project = join(geminiFixtureRoot, 'project');
    const workspace = join(project, 'packages', 'web');
    const ctx = {
      workspaceRoot: workspace, repoRoot: project, homeDir: join(geminiFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'gemini' as const, requestedSystem: 'gemini' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'gemini')).toBe(true);
      for (const [path, precedence] of [
        [join(project, '.gemini/skills/native/SKILL.md'), 100],
        [join(project, '.agents/skills/portable/SKILL.md'), 101],
        [join(workspace, '.gemini/skills/web/SKILL.md'), 80],
        [join(project, 'GEMINI.md'), 100],
        [join(project, 'packages/GEMINI.md'), 100],
        [join(workspace, 'GEMINI.md'), 80],
        [join(geminiFixtureRoot, 'home/.gemini/skills/user-native/SKILL.md'), 40],
        [join(geminiFixtureRoot, 'home/.agents/skills/user-portable/SKILL.md'), 41],
        [join(geminiFixtureRoot, 'home/.gemini/GEMINI.md'), 40],
        [join(geminiFixtureRoot, 'home/.gemini/extensions/example/skills/extension-skill/SKILL.md'), 20],
        [join(explicit, 'explicit.md'), 70]
      ] as const) expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: path, precedence }));
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'gemini', capability: 'configuration', code: 'SOURCE_UNSUPPORTED'
      }));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('gemini: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const skills = join(root, '.gemini', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'gemini-outside-'));
    ctx.requestedSystem = 'gemini';
    writeFixture(root, '.gemini/skills/safe/SKILL.md', '# Safe');
    writeFixture(root, '.gemini/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFixture(root, '.gemini/skills/oversized/SKILL.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'gemini', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2
      }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('gemini: deterministic precedence and redacted diagnostics', () => {
    const project = join(geminiFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: project, homeDir: join(geminiFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'gemini' as const
    };
    const result = discover(ctx);
    const compiled = compile(normalize(result.artifacts, ctx).inputs, ctx);
    const shared = compiled.manifests?.find(manifest => manifest.skillName === 'shared');
    expect(result.errors).toEqual([]);
    expect(shared?.sourcePath).toBe(join(project, '.agents/skills/shared/SKILL.md'));
    expect(shared?.precedence).toBe(101);
    expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(project);
    expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
  });

  it('gemini: absent and unsupported sources diagnose without runtime or broad extension crawling', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'gemini';
    writeFixture(ctx.homeDir, '.gemini/extensions/no-manifest/skills/hidden/SKILL.md', '# Hidden');
    writeFixture(ctx.homeDir, '.gemini/tmp/runtime/skills/hidden/SKILL.md', '# Runtime');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'gemini', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'gemini', capability: 'configuration', sourceType: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('no-manifest');
      expect(discoverSkillFolders(ctx.homeDir, 'home').candidates.some(candidate => candidate.path.includes('no-manifest'))).toBe(false);
    } finally { cleanup(); }
  });

  it('gemini: candidates include confirmed project user and installed-extension roots', () => {
    const projectCandidates = discoverSkillFolders(join(geminiFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(geminiFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.gemini/skills', system: 'gemini' }),
      expect.objectContaining({ path: '.agents/skills', system: 'gemini' }),
      expect.objectContaining({ path: 'GEMINI.md', system: 'gemini', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.gemini/skills', system: 'gemini' }),
      expect.objectContaining({ path: '.agents/skills', system: 'gemini' }),
      expect.objectContaining({ path: '.gemini/extensions/example/skills', system: 'gemini' })
    ]));
  });

  it('gemini: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'gemini-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(geminiFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(geminiFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'gemini'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'gemini')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.gemini/extensions/example/skills/extension-skill/SKILL.md'))).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'gemini'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'gemini')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Roo Code documented-roots/config adapter', () => {
  it('roo: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'roo-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const project = join(rooFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: null, homeDir: join(rooFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'roo' as const, requestedSystem: 'roo' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'roo')).toBe(true);
      for (const suffix of [
        '.roo/rules/general.md', '.roo/rules-code/code.md',
        '.roo/skills/shared/SKILL.md', '.roo/skills-code/shared/SKILL.md',
        '.agents/skills/portable/SKILL.md', '.agents/skills-code/mode-portable/SKILL.md',
        '.roo/rules/global.md', '.roo/rules-code/global-code.md',
        '.roo/skills/shared/SKILL.md', '.roo/skills-code/shared/SKILL.md',
        'AGENTS.md'
      ]) expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('AGENT.md'))).toBe(false);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.roorules'))).toBe(false);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.roorules-code'))).toBe(false);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'roo', capability: 'configuration', status: 'used', code: 'SOURCE_USED'
      }));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('roo: global workspace and mode precedence is deterministic', () => {
    const project = join(rooFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: project, homeDir: join(rooFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'roo' as const
    };
    const result = discover(ctx);
    const compiled = compile(normalize(result.artifacts, ctx).inputs, ctx);
    expect(result.errors).toEqual([]);
    expect(result.artifacts.find(artifact => artifact.absolutePath === join(project, '.roo/skills-code/shared/SKILL.md'))?.precedence).toBe(104);
    expect(result.artifacts.find(artifact => artifact.absolutePath === join(project, '.roo/skills/shared/SKILL.md'))?.precedence).toBe(103);
    expect(result.artifacts.find(artifact => artifact.absolutePath === join(rooFixtureRoot, 'home/.roo/skills-code/shared/SKILL.md'))?.precedence).toBe(44);
    expect(compiled.manifests?.find(manifest => manifest.skillName === 'shared')).toMatchObject({
      system: 'roo', sourcePath: join(project, '.roo/skills-code/shared/SKILL.md'), precedence: 104
    });
    expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(project);
    expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
  });

  it('roo: one discovery call shares one artifact budget across roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'roo';
    for (let index = 0; index < 2; index++) {
      writeFixture(root, `.roo/skills-code/mode-${index}/SKILL.md`, `# Mode ${index}`);
      writeFixture(root, `.roo/skills/generic-${index}/SKILL.md`, `# Generic ${index}`);
    }
    writeFixture(ctx.homeDir, '.roo/skills/global/SKILL.md', '# Must not be scanned');
    writeFixture(root, '.roorules', '# Must not be scanned');
    try {
      const diagnostics: import('../src/types.js').DiscoveryDiagnostic[] = [];
      const artifacts = discoverRoo(ctx, undefined, item => diagnostics.push(item), 3);
      expect(artifacts).toHaveLength(3);
      expect(artifacts.every(artifact => artifact.absolutePath.startsWith(root))).toBe(true);
      expect(diagnostics.filter(item => item.environment === 'roo' && item.code === 'SOURCE_TRUNCATED')).toHaveLength(1);
    } finally { cleanup(); }
  });

  it('roo: legacy fallback and stable extension setting are honored', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'roo';
    writeFixture(root, '.roorules', '# Generic legacy');
    writeFixture(root, '.roorules-code', '# Mode legacy');
    writeFixture(root, 'AGENTS.md', '# Disabled agents');
    writeFixture(root, '.vscode/settings.json', '{\n // documented workspace setting\n "roo-cline.useAgentRules": false\n}');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual(expect.arrayContaining([
        join(root, '.roorules'), join(root, '.roorules-code')
      ]));
      expect(result.artifacts.some(artifact => artifact.absolutePath === join(root, 'AGENTS.md'))).toBe(false);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', status: 'used', code: 'SOURCE_USED' }));
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', status: 'unavailable', code: 'SOURCE_UNSUPPORTED' }));
    } finally { cleanup(); }
  });

  it('roo: absent and unsupported sources diagnose without private state inference', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'roo';
    writeFixture(ctx.homeDir, '.vscode/extensions/rooveterinaryinc.roo-cline/private/prompt.md', '# Private');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'roo', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'roo', capability: 'configuration', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'roo', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('private/prompt.md');
    } finally { cleanup(); }
  });

  it('roo: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const skills = join(root, '.roo', 'skills');
    const outside = mkdtempSync(join(tmpdir(), 'roo-outside-'));
    ctx.requestedSystem = 'roo';
    writeFixture(root, '.roo/skills/safe/SKILL.md', '# Safe');
    writeFixture(root, '.roo/skills/node_modules/cached/SKILL.md', '# Cached');
    writeFixture(root, '.roo/skills/oversized/SKILL.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'SKILL.md'), '# Escaped');
    symlinkSync(outside, join(skills, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(skills, 'safe', 'SKILL.md')]);
      expect(JSON.stringify(result)).not.toContain('node_modules/cached');
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'roo', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2
      }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('roo: candidates include confirmed generic and mode-specific roots', () => {
    const projectCandidates = discoverSkillFolders(join(rooFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(rooFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.roo/skills', system: 'roo' }),
      expect.objectContaining({ path: '.roo/skills-code', system: 'roo' }),
      expect.objectContaining({ path: '.agents/skills-code', system: 'roo' }),
      expect.objectContaining({ path: '.roo/rules', system: 'roo' }),
      expect.objectContaining({ path: '.roo/rules-code', system: 'roo' }),
      expect.objectContaining({ path: 'AGENTS.md', system: 'roo', indexable: false }),
      expect.objectContaining({ path: '.roorules-code', system: 'roo', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.roo/skills', system: 'roo' }),
      expect.objectContaining({ path: '.roo/skills-code', system: 'roo' }),
      expect.objectContaining({ path: '.roo/rules-code', system: 'roo' })
    ]));
  });

  it('roo: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'roo-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(rooFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(rooFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'roo'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'roo')).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'roo'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'roo')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Continue documented-roots/config adapter', () => {
  it('continue: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'continue-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const project = join(continueFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: null, homeDir: join(continueFixtureRoot, 'home'),
      includeGlobals: false, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'continue' as const, requestedSystem: 'continue' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'continue')).toBe(true);
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ relativePath: '.continue/rules/01-general.md', kind: 'rule_file' }),
        expect.objectContaining({ relativePath: '.continue/rules/02-typescript.md', kind: 'rule_file' }),
        expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 })
      ]));
      const yamlRule = normalize(result.artifacts, ctx).inputs.find(input => input.sourcePath.endsWith('02-typescript.md'));
      expect(yamlRule?.frontmatter).toMatchObject({ name: 'TypeScript rule', globs: ['**/*.ts'], alwaysApply: false });
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('continue: active config uses bounded local rule and prompt files only', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'continue';
    const rule = writeFixture(ctx.homeDir, '.continue/library/user-rule.md', '# User rule');
    const prompt = writeFixture(ctx.homeDir, '.continue/library/review.md', '---\nname: Review\ninvokable: true\n---\n\n# Review');
    writeFixture(ctx.homeDir, '.continue/config.json', '{ malformed legacy fallback');
    writeFixture(ctx.homeDir, '.continue/config.yaml', [
      'name: Local Config', 'version: 1.0.0', 'schema: v1',
      'rules:', `  - uses: ${pathToFileURL(rule).href}`, '  - Inline text is not emitted',
      'prompts:', `  - uses: ${pathToFileURL(prompt).href}`
    ].join('\n'));
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ absolutePath: rule, kind: 'rule_file', precedence: 40 }),
        expect.objectContaining({ absolutePath: prompt, kind: 'instruction_file', precedence: 40 })
      ]));
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'continue', capability: 'configuration', status: 'limited', foundCount: 2, skippedCount: 1
      }));
      expect(JSON.stringify(result)).not.toContain('Inline text is not emitted');
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
    } finally { cleanup(); }
  });

  it('continue: deterministic workspace repository and global precedence', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'continue';
    const globalRule = writeFixture(ctx.homeDir, '.continue/library/shared.md', '# Global');
    writeFixture(ctx.homeDir, '.continue/config.yaml', `name: Local\nversion: 1.0.0\nschema: v1\nrules:\n  - uses: ${pathToFileURL(globalRule).href}\n`);
    writeFixture(root, '.continue/rules/shared.md', '# Workspace');
    writeFixture(repo, '.continue/rules/shared.md', '# Repository');
    try {
      const result = discover(ctx);
      const winner = compile(normalize(result.artifacts, ctx).inputs, ctx).manifests?.find(manifest => manifest.skillName === 'shared');
      expect(result.errors).toEqual([]);
      expect(winner).toMatchObject({ system: 'continue', sourcePath: join(repo, '.continue/rules/shared.md'), precedence: 100 });
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.continue/rules/shared.md'))?.precedence).toBe(80);
      expect(result.artifacts.find(artifact => artifact.absolutePath === globalRule)?.precedence).toBe(40);
    } finally { cleanup(); }
  });

  it('continue: absent unsupported and malformed config are nonfatal diagnostics', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'continue';
    try {
      const absent = discover(ctx);
      expect(absent.errors).toEqual([]);
      expect(absent.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'continue', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'continue', capability: 'configuration', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'continue', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));

      writeFixture(ctx.homeDir, '.continue/config.yaml', 'schema: v1\nrules: [unterminated');
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'continue', capability: 'configuration', status: 'skipped', code: 'SOURCE_INVALID' }),
        expect.objectContaining({ environment: 'continue', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(result.discoveryDiagnostics?.every(item => item.explicitRootGuidance === 'Pass trusted directories in index_skills.roots.')).toBe(true);
    } finally { cleanup(); }
  });

  it('continue: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const rules = join(root, '.continue', 'rules');
    const outside = mkdtempSync(join(tmpdir(), 'continue-outside-'));
    ctx.requestedSystem = 'continue';
    writeFixture(root, '.continue/rules/safe.md', '# Safe');
    writeFixture(root, '.continue/rules/oversized.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFixture(root, '.continue/rules/ignored.yaml', 'name: ignored');
    writeFileSync(join(outside, 'escaped.md'), '# Escaped');
    symlinkSync(outside, join(rules, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(rules, 'safe.md')]);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'continue', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2
      }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('continue: candidates include only the confirmed workspace rule root', () => {
    const projectCandidates = discoverSkillFolders(join(continueFixtureRoot, 'project')).candidates;
    expect(projectCandidates).toContainEqual(expect.objectContaining({ path: '.continue/rules', system: 'continue', kind: 'rule_directory' }));
    expect(discoverSkillFolders(join(continueFixtureRoot, 'home'), 'home').candidates.some(candidate => candidate.system === 'continue')).toBe(false);
  });

  it('continue: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'continue-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(continueFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(continueFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'continue'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'continue')).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'continue'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'continue')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Aider documented-config adapter', () => {
  it('aider: public ID is accepted by validators and both MCP schemas', () => {
    expect(validateIndexSkillsArgs({ system: 'aider' })).toEqual({ ok: true, value: { system: 'aider', roots: undefined, baseDir: undefined, force: undefined } });
    expect(validateListSkillsArgs({ system: 'aider' })).toEqual({ ok: true, value: { system: 'aider' } });
    for (const name of ['index_skills', 'list_skills']) {
      const tool = TOOL_DEFS.find(definition => definition.name === name)!;
      expect((tool.inputSchema.properties.system as { enum: string[] }).enum).toContain('aider');
    }
  });

  it('aider: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'aider-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const project = join(aiderFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: null, homeDir: join(aiderFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'aider' as const, requestedSystem: 'aider' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ absolutePath: join(project, 'CONVENTIONS.md'), system: 'aider', kind: 'convention_file', precedence: 80 }),
        expect.objectContaining({ absolutePath: join(project, 'docs/PROJECT.md'), system: 'aider', kind: 'instruction_file', precedence: 80 }),
        expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), system: 'aider', precedence: 70 })
      ]));
      expect(result.artifacts.some(artifact => artifact.absolutePath === join(project, 'USER.md'))).toBe(false);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'aider', capability: 'configuration', status: 'used', foundCount: 2 }));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('aider: project config retains precedence over user config', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'aider';
    writeFixture(root, 'PROJECT.md', '# Project');
    writeFixture(root, 'USER.md', '# User');
    writeFixture(root, '.aider.conf.yml', 'read: PROJECT.md');
    writeFixture(ctx.homeDir, '.aider.conf.yml', 'read: USER.md');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([expect.objectContaining({ absolutePath: join(root, 'PROJECT.md'), system: 'aider', precedence: 80 })]);
      rmSync(join(root, '.aider.conf.yml'));
      expect(discover(ctx).artifacts).toEqual([expect.objectContaining({ absolutePath: join(root, 'USER.md'), system: 'aider', precedence: 40 })]);
    } finally { cleanup(); }
  });

  it('aider: malformed unsafe and missing references are bounded nonfatal diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'aider-outside-'));
    ctx.requestedSystem = 'aider';
    writeFixture(root, '.aider.conf.yml', 'read: [unterminated');
    try {
      const malformed = discover(ctx);
      expect(malformed.errors).toEqual([]);
      expect(malformed.discoveryDiagnostics).toContainEqual(expect.objectContaining({ environment: 'aider', code: 'SOURCE_INVALID', status: 'skipped' }));

      writeFileSync(join(outside, 'escaped.md'), '# Escaped');
      symlinkSync(join(outside, 'escaped.md'), join(root, 'linked.md'));
      writeFixture(root, '.aider.conf.yml', 'read: [missing.md, linked.md]');
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'aider', code: 'SOURCE_ABSENT', skippedCount: 1 }),
        expect.objectContaining({ environment: 'aider', code: 'SOURCE_UNSAFE', skippedCount: 1 })
      ]));
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(outside);
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('aider: absent unsupported and arbitrary convention files are not inferred', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'aider';
    writeFixture(root, 'CONVENTIONS.md', '# Not configured');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'aider', capability: 'configuration', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'aider', capability: 'roots', code: 'SOURCE_UNSUPPORTED' }),
        expect.objectContaining({ environment: 'aider', limitation: expect.stringContaining('Session /read state') })
      ]));
    } finally { cleanup(); }
  });

  it('aider: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'aider-bounds-'));
    ctx.requestedSystem = 'aider';
    writeFixture(root, 'safe.md', '# Safe');
    writeFixture(root, 'oversized.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'escaped.md'), '# Escaped');
    symlinkSync(join(outside, 'escaped.md'), join(root, 'linked.md'));
    const refs = ['safe.md', 'oversized.md', 'linked.md', ...Array.from({ length: 100 }, (_, index) => `missing-${index}.md`)];
    writeFixture(root, '.aider.conf.yml', `read: [${refs.join(', ')}]`);
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.length).toBeLessThanOrEqual(100);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'aider', code: 'SOURCE_TRUNCATED', skippedCount: 100 }),
        expect.objectContaining({ environment: 'aider', code: 'SOURCE_UNSAFE' })
      ]));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('aider: the inspection cap includes invalid read entries', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'aider';
    writeFixture(root, '.aider.conf.yml', `read: [${Array.from({ length: 101 }, () => 'null').join(', ')}]`);
    try {
      const result = discover(ctx);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics?.filter(item => item.environment === 'aider' && item.code === 'SOURCE_TRUNCATED')).toHaveLength(1);
    } finally { cleanup(); }
  });

  it('aider: candidates report config locations without inventing a skill root', () => {
    const projectCandidates = discoverSkillFolders(join(aiderFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(aiderFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toContainEqual(expect.objectContaining({ path: '.aider.conf.yml', system: 'aider', indexable: false, kind: 'configuration_file' }));
    expect(homeCandidates).toContainEqual(expect.objectContaining({ path: '.aider.conf.yml', system: 'aider', indexable: false, kind: 'configuration_file' }));
    expect([...projectCandidates, ...homeCandidates].some(candidate => candidate.system === 'aider' && candidate.indexable)).toBe(false);
  });

  it('aider: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'aider-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(aiderFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(aiderFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'aider'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'aider')).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'aider'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'aider')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Cline documented-roots/config adapter', () => {
  it('cline: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'cline-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit Cline rule');
    const project = join(clineFixtureRoot, 'project');
    const ctx = {
      workspaceRoot: project, repoRoot: null, homeDir: join(clineFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [explicit],
      explicitRootSystem: 'cline' as const, requestedSystem: 'cline' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'cline')).toBe(true);
      for (const suffix of [
        '.clinerules/01-project.md', '.clinerules/nested/testing.txt', '.cline/rules/current.md',
        '.cline/skills/review/SKILL.md', '.clinerules/skills/legacy/SKILL.md', '.claude/skills/compatible/SKILL.md',
        'AGENTS.md', '.cursorrules', '.windsurfrules', '.cline/rules/global.md',
        '.cline/skills/global/SKILL.md', 'Documents/Cline/Rules/documents.md', '.agents/AGENTS.md'
      ]) expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.clinerules/workflows/ignored.md'))).toBe(false);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'cline', capability: 'configuration', status: 'used', code: 'SOURCE_USED' }),
        expect.objectContaining({ environment: 'cline', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('cline: supports legacy single-file .clinerules and compatibility instructions', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'cline';
    writeFixture(root, '.clinerules', '# Legacy custom instructions');
    writeFixture(root, 'AGENTS.md', '# Agents');
    writeFixture(root, '.cursorrules', '# Cursor');
    writeFixture(root, '.windsurfrules', '# Windsurf');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.relativePath).sort()).toEqual(['.clinerules', '.cursorrules', '.windsurfrules', 'AGENTS.md']);
      expect(result.artifacts.every(artifact => artifact.system === 'cline' && artifact.precedence === 80)).toBe(true);
    } finally { cleanup(); }
  });

  it('cline: absent and malformed private config diagnose without state crawling', () => {
    const { ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'cline';
    writeFixture(ctx.homeDir, '.cline/data/settings/global-settings.json', '{broken');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'cline', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'cline', capability: 'configuration', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'cline', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result)).not.toContain('global-settings.json');
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('cline: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const rules = join(root, '.clinerules');
    const outside = mkdtempSync(join(tmpdir(), 'cline-outside-'));
    ctx.requestedSystem = 'cline';
    writeFixture(root, '.clinerules/safe.md', '# Safe');
    writeFixture(root, '.clinerules/oversized.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFixture(root, '.clinerules/ignored.json', '{broken');
    writeFixture(ctx.homeDir, '.cline/data/settings/global-settings.json', '{broken');
    writeFileSync(join(outside, 'escaped.md'), '# Escaped');
    symlinkSync(outside, join(rules, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(rules, 'safe.md')]);
      expect(JSON.stringify(result)).not.toContain('global-settings.json');
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'cline', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2 }),
        expect.objectContaining({ environment: 'cline', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('cline: deterministic precedence and redacted diagnostics', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const repo = join(root, 'repo');
    ctx.repoRoot = repo;
    ctx.requestedSystem = 'cline';
    writeFixture(root, '.cline/skills/shared/SKILL.md', '# Workspace');
    writeFixture(repo, '.cline/skills/shared/SKILL.md', '# Repository');
    writeFixture(root, '.clinerules/shared.md', '# Legacy');
    writeFixture(root, '.cline/rules/shared.md', '# Current');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(repo, '.cline/skills/shared/SKILL.md'))?.precedence).toBe(100);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.cline/skills/shared/SKILL.md'))?.precedence).toBe(80);
      expect(result.artifacts.find(artifact => artifact.absolutePath === join(root, '.cline/rules/shared.md'))?.precedence).toBe(81);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(root);
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('cline: Plan and Act mode rules stay common when active mode is unavailable', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'cline';
    writeFixture(root, '.clinerules/common.md', '# Common to Plan and Act');
    writeFixture(root, '.clinerules-plan/guessed.md', '# Guessed mode root');
    try {
      const result = discover(ctx);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(root, '.clinerules/common.md') }));
      expect(result.artifacts.some(artifact => artifact.absolutePath.includes('.clinerules-plan'))).toBe(false);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'cline', code: 'SOURCE_UNSUPPORTED', limitation: expect.stringContaining('Plan or Act mode')
      }));
    } finally { cleanup(); }
  });

  it('cline: candidates include confirmed project and global roots', () => {
    const projectCandidates = discoverSkillFolders(join(clineFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(clineFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.clinerules', system: 'cline', kind: 'rule_directory' }),
      expect.objectContaining({ path: '.cline/rules', system: 'cline', kind: 'rule_directory' }),
      expect.objectContaining({ path: '.cline/skills', system: 'cline', kind: 'skill_directory' }),
      expect.objectContaining({ path: 'AGENTS.md', system: 'cline', indexable: false })
    ]));
    expect(homeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.cline/rules', system: 'cline' }),
      expect.objectContaining({ path: '.cline/skills', system: 'cline' }),
      expect.objectContaining({ path: 'Documents/Cline/Rules', system: 'cline' })
    ]));
  });

  it('cline: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'cline-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(clineFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(clineFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'cline'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'cline')).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'cline'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'cline')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});

describe('Windsurf / Devin Desktop documented-roots adapter', () => {
  it('windsurf: public ID is accepted by both MCP schema surfaces', () => {
    expect(validateIndexSkillsArgs({ system: 'windsurf' })).toEqual({ ok: true, value: { system: 'windsurf', roots: undefined, baseDir: undefined, force: undefined } });
    expect(validateListSkillsArgs({ system: 'windsurf' })).toEqual({ ok: true, value: { system: 'windsurf' } });
    for (const name of ['index_skills', 'list_skills']) {
      const tool = TOOL_DEFS.find(definition => definition.name === name);
      expect((tool?.inputSchema.properties?.system as { enum?: string[] }).enum).toContain('windsurf');
    }
  });

  it('windsurf: documented roots and explicit fallback', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'windsurf-explicit-'));
    writeFileSync(join(explicit, 'explicit.md'), '# Explicit');
    const ctx = {
      workspaceRoot: join(windsurfFixtureRoot, 'project'), repoRoot: null,
      homeDir: join(windsurfFixtureRoot, 'home'), includeGlobals: true, includeSystem: false,
      explicitRoots: [explicit], explicitRootSystem: 'windsurf' as const, requestedSystem: 'windsurf' as const
    };
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.every(artifact => artifact.system === 'windsurf')).toBe(true);
      for (const suffix of [
        '.devin/rules/current.md', '.windsurfrules', 'AGENTS.md',
        'packages/api/.windsurf/rules/legacy.md', 'packages/api/AGENTS.md',
        '.codeium/windsurf/memories/global_rules.md'
      ]) expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith(suffix))).toBe(true);
      expect(result.artifacts.some(artifact => artifact.absolutePath.endsWith('.windsurf/rules/ignored.md'))).toBe(false);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ absolutePath: join(explicit, 'explicit.md'), precedence: 70 }));
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'windsurf', capability: 'configuration', code: 'SOURCE_UNSUPPORTED'
      }));
    } finally { rmSync(explicit, { recursive: true, force: true }); }
  });

  it('windsurf: AGENTS hierarchy and current-over-legacy precedence are deterministic', () => {
    const project = join(windsurfFixtureRoot, 'project');
    const result = discover({
      workspaceRoot: project, repoRoot: null, homeDir: join(windsurfFixtureRoot, 'home'),
      includeGlobals: true, includeSystem: false, explicitRoots: [], requestedSystem: 'windsurf'
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ absolutePath: join(project, 'AGENTS.md'), precedence: 80 }),
      expect.objectContaining({ absolutePath: join(project, 'packages/api/AGENTS.md'), precedence: 82 }),
      expect.objectContaining({ absolutePath: join(project, '.devin/rules/current.md'), precedence: 82 }),
      expect.objectContaining({ absolutePath: join(project, 'packages/api/.windsurf/rules/legacy.md'), precedence: 83 }),
      expect.objectContaining({ absolutePath: join(windsurfFixtureRoot, 'home/.codeium/windsurf/memories/global_rules.md'), precedence: 40 })
    ]));
  });

  it('windsurf: absent and unsupported sources diagnose without private-state crawling', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'windsurf';
    writeFixture(ctx.homeDir, '.codeium/windsurf/memories/workspace/private.md', '# Private memory');
    writeFixture(ctx.homeDir, 'Library/Application Support/Devin/User/globalStorage/private/rule.md', '# Private state');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toEqual([]);
      expect(result.discoveryDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ environment: 'windsurf', capability: 'roots', code: 'SOURCE_ABSENT' }),
        expect.objectContaining({ environment: 'windsurf', capability: 'configuration', code: 'SOURCE_UNSUPPORTED' })
      ]));
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('private.md');
      expect(JSON.stringify(result.discoveryDiagnostics)).not.toContain(ctx.homeDir);
    } finally { cleanup(); }
  });

  it('windsurf: absent inaccessible excluded and bounded roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const rules = join(root, '.devin', 'rules');
    const outside = mkdtempSync(join(tmpdir(), 'windsurf-outside-'));
    ctx.requestedSystem = 'windsurf';
    writeFixture(root, '.devin/rules/safe.md', '# Safe');
    writeFixture(root, '.devin/rules/oversized.md', Buffer.alloc(scannerLimits.fileBytes + 1).toString());
    writeFileSync(join(outside, 'escaped.md'), '# Escaped');
    symlinkSync(outside, join(rules, 'escape'), 'dir');
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts.map(artifact => artifact.absolutePath)).toEqual([join(rules, 'safe.md')]);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'windsurf', status: 'limited', code: 'SOURCE_UNSAFE', skippedCount: 2
      }));
    } finally { cleanup(); rmSync(outside, { recursive: true, force: true }); }
  });

  it('windsurf: caps aggregate workspace artifacts', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    ctx.requestedSystem = 'windsurf';
    for (let index = 0; index <= scannerLimits.results; index++) writeFixture(root, `package-${index}/AGENTS.md`, `# ${index}`);
    try {
      const result = discover(ctx);
      expect(result.errors).toEqual([]);
      expect(result.artifacts).toHaveLength(scannerLimits.results);
      expect(result.discoveryDiagnostics).toContainEqual(expect.objectContaining({
        environment: 'windsurf', status: 'truncated', code: 'SOURCE_TRUNCATED'
      }));
    } finally { cleanup(); }
  });

  it('windsurf: shares one visit budget across empty nested roots', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    const limits = { ...scannerLimits, entries: 12 };
    const budget = createScanBudget(limits);
    const reports: import('../src/discovery/shared.js').ScanSafetyResult[] = [];
    ctx.requestedSystem = 'windsurf';
    for (let index = 0; index < 20; index++) mkdirSync(join(root, `empty-${index}`, 'nested'), { recursive: true });
    try {
      expect(discoverWindsurf(ctx, report => reports.push(report), undefined, budget)).toEqual([]);
      expect(budget.entries).toBe(limits.entries);
      expect(reports.filter(report => report.truncated)).toHaveLength(1);
    } finally { cleanup(); }
  });

  it('windsurf: candidates include current, compatibility, hierarchy, and global-rule roots', () => {
    const projectCandidates = discoverSkillFolders(join(windsurfFixtureRoot, 'project')).candidates;
    const homeCandidates = discoverSkillFolders(join(windsurfFixtureRoot, 'home'), 'home').candidates;
    expect(projectCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.devin/rules', system: 'windsurf', kind: 'rule_directory' }),
      expect.objectContaining({ path: '.windsurf/rules', system: 'windsurf', kind: 'rule_directory' }),
      expect.objectContaining({ path: 'AGENTS.md', system: 'windsurf', indexable: false }),
      expect.objectContaining({ path: 'packages/api/AGENTS.md', system: 'windsurf', indexable: false }),
      expect.objectContaining({ path: '.windsurfrules', system: 'windsurf', indexable: false })
    ]));
    expect(homeCandidates).toContainEqual(expect.objectContaining({
      path: '.codeium/windsurf/memories/global_rules.md', system: 'windsurf', indexable: false
    }));
  });

  it('windsurf: discover normalize compile store compatibility', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'windsurf-store-'));
    const store = new FileStore(storeDir);
    await store.init();
    try {
      const deps = {
        discover, normalize, compile, loadContext, store,
        resolveHomeDir: () => join(windsurfFixtureRoot, 'home'),
        resolveWorkspaceRoot: () => join(windsurfFixtureRoot, 'project')
      };
      const response = JSON.parse(await handleIndexSkills(deps, 'windsurf'));
      expect(response.errors).toEqual([]);
      expect(response.indexedSkills).toBeGreaterThan(0);
      expect(response.discoveryDiagnostics).toContainEqual(expect.objectContaining({ capability: 'configuration', code: 'SOURCE_UNSUPPORTED' }));
      const manifests = Object.values(await store.readManifests());
      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every(manifest => manifest.system === 'windsurf')).toBe(true);
      expect(manifests.some(manifest => manifest.sourcePath.endsWith('.devin/rules/current.md'))).toBe(true);
      const listed = JSON.parse(await handleListSkills(deps, 'windsurf'));
      expect(listed.skills.length).toBeGreaterThan(0);
      expect(listed.skills.every((skill: { system: string }) => skill.system === 'windsurf')).toBe(true);
    } finally { rmSync(storeDir, { recursive: true, force: true }); }
  });
});
