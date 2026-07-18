import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidateDiscoveryDefaults, discoverSkillFolders, normalizeRelativePath } from '../src/discovery/candidates.js';
import { SOURCE_SYSTEMS } from '../src/types.js';

const linkDirectory = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

describe('discoverSkillFolders', () => {
  it('normalizes Windows-style relative paths for portable known-root matching', () => {
    expect(normalizeRelativePath('.claude\\skills\\demo')).toBe('.claude/skills/demo');
  });

  it('finds known roots, generic skills directories, and root instructions without reading content', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-discovery-'));
    try {
      for (const dir of ['.claude/skills/demo', '.claude/commands', '.opencode/skills/lowercase', '.agents/skills/compatible', '.opencode/rules', '.github/skills/copilot', '.github/instructions', '.cursor/rules', 'arbitrary/nested/skills/demo']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), 'secret content');
      writeFileSync(join(root, '.opencode', 'skills', 'lowercase', 'skill.md'), 'also secret');
      writeFileSync(join(root, 'arbitrary', 'nested', 'skills', 'demo', 'SKILL.md'), 'must be found without being read');
      for (const file of ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']) writeFileSync(join(root, file), 'instructions');
      const result = discoverSkillFolders(root);
      const indexRoot = result.root;
      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '.claude/skills', system: 'claude', indexable: true, indexRoot: join(indexRoot, '.claude', 'skills') }),
        expect.objectContaining({ path: '.claude/commands', system: 'claude', indexable: true, indexRoot: join(indexRoot, '.claude', 'commands') }),
        expect.objectContaining({ path: '.claude/skills/demo/SKILL.md', system: 'claude', indexable: true, indexRoot: join(indexRoot, '.claude', 'skills', 'demo') }),
        expect.objectContaining({ path: '.opencode/skills/lowercase/skill.md', system: 'opencode', indexable: true, indexRoot: join(indexRoot, '.opencode', 'skills', 'lowercase') }),
        expect.objectContaining({ path: '.agents/skills', system: 'opencode', indexable: true }),
        expect.objectContaining({ path: '.agents/skills', system: 'codex', indexable: true }),
        expect.objectContaining({ path: '.github/skills', system: 'copilot', indexable: true }),
        expect.objectContaining({ path: '.github/instructions', system: 'copilot', indexable: true }),
        expect.objectContaining({ path: '.cursor/rules', system: 'cursor', indexable: true }),
        expect.objectContaining({ path: 'arbitrary/nested/skills', system: 'generic', indexable: true, indexRoot: join(indexRoot, 'arbitrary', 'nested', 'skills'), matchedBy: 'skills_directory' }),
        expect.objectContaining({ path: 'arbitrary/nested/skills/demo/SKILL.md', system: 'generic', indexRoot: join(indexRoot, 'arbitrary', 'nested', 'skills', 'demo') }),
        expect.objectContaining({ path: 'AGENTS.md', system: 'opencode', indexable: false, kind: 'instruction_file' }),
        expect.objectContaining({ path: 'AGENTS.md', system: 'codex', indexable: false, kind: 'instruction_file' }),
        expect.objectContaining({ path: 'CLAUDE.md', system: 'claude', indexable: false, kind: 'instruction_file' }),
        expect.objectContaining({ path: '.github/copilot-instructions.md', system: 'copilot', indexable: false, kind: 'instruction_file' })
      ]));
      expect(result.candidates.some(c => c.path.startsWith('.cursor/commands'))).toBe(false);
      expect(result.candidates.some(c => c.path === '.opencode/rules')).toBe(false);
      expect(result.candidates.every(c => SOURCE_SYSTEMS.includes(c.system) && (!c.indexable || typeof c.indexRoot === 'string'))).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret content');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('finds every supported home root, including OpenCode-compatible roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-home-'));
    try {
      for (const dir of ['.claude/skills', '.opencode/skills', '.config/opencode/skills', '.config/opencode/skill', '.agents/skills', '.copilot/skills', '.copilot/instructions', '.copilot/agents', '.cursor/skills', '.cursor/rules', '.gemini/skills']) mkdirSync(join(root, dir), { recursive: true });
      const result = discoverSkillFolders(root, 'home');
      expect(result.candidates.map(c => `${c.system}:${c.path}`)).toEqual(expect.arrayContaining([
        'claude:.claude/skills', 'opencode:.config/opencode/skills', 'opencode:.config/opencode/skill',
        'opencode:.claude/skills', 'opencode:.agents/skills', 'codex:.agents/skills',
        'copilot:.copilot/skills', 'copilot:.copilot/instructions', 'copilot:.copilot/agents',
        'cursor:.cursor/skills', 'cursor:.claude/skills', 'cursor:.agents/skills',
        'gemini:.gemini/skills', 'gemini:.agents/skills'
      ]));
      expect(result.candidates.every(c => c.indexable && typeof c.indexRoot === 'string')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps bounded enumeration inside canonical roots and skips symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-discovery-'));
    const outside = mkdtempSync(join(tmpdir(), 'candidate-outside-'));
    try {
      mkdirSync(join(root, '.claude', 'skills', 'deep', 'one', 'two'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'bad'), { recursive: true });
      writeFileSync(join(root, '.claude', 'skills', 'deep', 'one', 'two', 'skill.md'), 'deep');
      writeFileSync(join(root, 'node_modules', 'bad', 'SKILL.md'), 'ignored');
      mkdirSync(join(root, 'internal-target'), { recursive: true });
      writeFileSync(join(root, 'internal-target', 'SKILL.md'), 'internal symlink target');
      writeFileSync(join(outside, 'SKILL.md'), 'escaping symlink target');
      linkDirectory(join(root, 'internal-target'), join(root, '.claude', 'skills', 'internal-link'));
      linkDirectory(outside, join(root, '.claude', 'skills', 'escape-link'));
      const shallow = discoverSkillFolders(root, 'project', 1);
      expect(shallow.candidates).toEqual([
        expect.objectContaining({ path: '.claude/skills', system: 'claude' }),
        expect.objectContaining({ path: '.claude/skills', system: 'opencode' }),
        expect.objectContaining({ path: '.claude/skills', system: 'copilot' }),
        expect.objectContaining({ path: '.claude/skills', system: 'cursor' }),
        expect.objectContaining({ path: '.claude/skills', system: 'cline' })
      ]);
      const capped = discoverSkillFolders(root, 'project', 5, 1);
      expect(capped.truncated).toBe(true);
      const uncapped = discoverSkillFolders(root, 'project', 5, 100);
      expect(uncapped.candidates.some(c => c.path.includes('node_modules') || c.path.includes('internal-link') || c.path.includes('escape-link'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it('keeps known skills roots mapped to native and documented compatible harnesses', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-dedup-'));
    try {
      mkdirSync(join(root, '.claude', 'skills', 'demo'), { recursive: true });
      writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '# demo');
      const result = discoverSkillFolders(root);
      const candidates = result.candidates;
      const knownRoot = join(result.root, '.claude', 'skills');
      const matches = candidates.filter(c => c.indexRoot === knownRoot);
      expect(matches).toEqual([
        expect.objectContaining({ system: 'claude', matchedBy: 'known_harness_path' }),
        expect.objectContaining({ system: 'opencode', matchedBy: 'known_harness_path' }),
        expect.objectContaining({ system: 'copilot', matchedBy: 'known_harness_path' }),
        expect.objectContaining({ system: 'cursor', matchedBy: 'known_harness_path' }),
        expect.objectContaining({ system: 'cline', matchedBy: 'known_harness_path' })
      ]);
      expect(candidates.some(c => c.system === 'generic' && c.indexRoot === knownRoot)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('finds nested home skills while honoring exclusions and symlink containment', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-home-generic-'));
    const outside = mkdtempSync(join(tmpdir(), 'candidate-outside-'));
    try {
      mkdirSync(join(root, 'unknown', 'harness', 'skills', 'demo'), { recursive: true });
      writeFileSync(join(root, 'unknown', 'harness', 'skills', 'demo', 'skill.md'), '# demo');
      mkdirSync(join(root, 'unknown', 'Skills', 'wrong-case'), { recursive: true });
      writeFileSync(join(root, 'unknown', 'Skills', 'wrong-case', 'SKILL.md'), '# ignored');
      for (const excluded of ['.git', 'node_modules', 'Library', 'Downloads', 'Trash', 'Caches', 'vendor', 'dist', 'build', 'target']) {
        mkdirSync(join(root, excluded, 'skills', 'bad'), { recursive: true });
        writeFileSync(join(root, excluded, 'skills', 'bad', 'SKILL.md'), '# bad');
      }
      mkdirSync(join(outside, 'skills', 'escaped'), { recursive: true });
      writeFileSync(join(outside, 'skills', 'escaped', 'SKILL.md'), '# escaped');
      linkDirectory(outside, join(root, 'escape'));
      const paths = discoverSkillFolders(root, 'home', 5, 100, 10_000, 'darwin').candidates.map(c => c.path);
      expect(paths).toContain('unknown/harness/skills');
      expect(paths).toContain('unknown/harness/skills/demo/skill.md');
      expect(paths.some(path => path.includes('Skills'))).toBe(false);
      expect(paths.some(path => path.includes('bad') || path.includes('escape'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it.each([
    ['darwin', ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos', 'Library', 'Movies', 'Applications', 'Trash']],
    ['win32', ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos', 'AppData', 'Contacts', 'Favorites', 'Links', 'OneDrive', 'Saved Games', 'Searches', '3D Objects']],
    ['linux', ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Public', 'Templates', 'Videos', '.local/share/Trash']]
  ] as const)('applies %s home exclusions relative to the home root', (platform, excluded) => {
    const root = mkdtempSync(join(tmpdir(), `candidate-${platform}-`));
    try {
      for (const dir of excluded) {
        mkdirSync(join(root, dir, 'skills', 'bad'), { recursive: true });
        writeFileSync(join(root, dir, 'skills', 'bad', 'SKILL.md'), '# bad');
      }
      mkdirSync(join(root, '.config/opencode/skills/demo'), { recursive: true });
      writeFileSync(join(root, '.config/opencode/skills/demo/SKILL.md'), '# demo');
      const paths = discoverSkillFolders(root, 'home', 5, 100, 10_000, platform).candidates.map(c => c.path);
      expect(paths).toContain('.config/opencode/skills/demo/SKILL.md');
      for (const dir of excluded) expect(paths.some(path => path.startsWith(`${dir}/`))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not enter hidden home directories except dedicated Gemini and Roo paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-hidden-home-'));
    try {
      for (const dir of ['.ssh', '.aws', '.gnupg', '.config-unrelated', '.local-unrelated', '.local/share']) {
        mkdirSync(join(root, dir, 'skills', 'demo'), { recursive: true });
        writeFileSync(join(root, dir, 'skills', 'demo', 'SKILL.md'), '# skill');
      }
      for (const dir of ['.claude/skills/direct', '.config/opencode/skills/direct', '.gemini/skills/direct', '.agents/skills/direct', '.roo/skills-code/mode', '.roo/rules-code', '.agents/skills-code/mode']) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'SKILL.md'), '# skill');
      }
      mkdirSync(join(root, '.gemini/extensions/verified/skills/extension'), { recursive: true });
      writeFileSync(join(root, '.gemini/extensions/verified/gemini-extension.json'), '{}');
      writeFileSync(join(root, '.gemini/extensions/verified/skills/extension/SKILL.md'), '# skill');
      const paths = discoverSkillFolders(root, 'home', 5, 100, 10_000, 'linux').candidates.map(c => c.path);
      expect(paths).toEqual(expect.arrayContaining([
        '.claude/skills', '.claude/skills/direct/SKILL.md',
        '.config/opencode/skills', '.config/opencode/skills/direct/SKILL.md',
        '.gemini/skills', '.gemini/skills/direct/SKILL.md',
        '.agents/skills', '.agents/skills/direct/SKILL.md',
        '.gemini/extensions/verified/skills', '.gemini/extensions/verified/skills/extension/SKILL.md',
        '.roo/skills-code', '.roo/rules-code', '.agents/skills-code'
      ]));
      expect(paths.some(path => path === '.roo/skills-code/mode/SKILL.md' || path === '.agents/skills-code/mode/SKILL.md')).toBe(false);
      const keys = discoverSkillFolders(root, 'home', 5, 100, 10_000, 'linux').candidates.map(candidate => `${candidate.system}:${candidate.path}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const dir of ['.ssh', '.aws', '.gnupg', '.config-unrelated', '.local-unrelated', '.local']) {
        expect(paths.some(path => path.startsWith(`${dir}/`))).toBe(false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('excludes home folders only at their root-relative locations', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-relative-exclusions-'));
    try {
      for (const dir of ['Library/skills/root', 'nested/Library/skills/demo', 'nested/Downloads/skills/demo', 'nested/Trash/skills/demo']) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'SKILL.md'), '# skill');
      }
      const paths = discoverSkillFolders(root, 'home', 5, 100, 10_000, 'darwin').candidates.map(c => c.path);
      expect(paths.some(path => path.startsWith('Library/'))).toBe(false);
      expect(paths).toContain('nested/Library/skills/demo/SKILL.md');
      expect(paths).toContain('nested/Downloads/skills/demo/SKILL.md');
      expect(paths).toContain('nested/Trash/skills/demo/SKILL.md');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves project-scope exclusions at every depth', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-project-exclusions-'));
    try {
      for (const dir of ['Library/skills/bad', 'nested/Library/skills/bad', 'Downloads/skills/bad', 'nested/Downloads/skills/bad']) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'SKILL.md'), '# bad');
      }
      const paths = discoverSkillFolders(root, 'project').candidates.map(c => c.path);
      expect(paths.some(path => path.includes('/skills/bad/'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('bounds generic discovery by depth, result count, and scanned entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidate-caps-'));
    try {
      mkdirSync(join(root, 'one', 'two', 'skills', 'demo'), { recursive: true });
      writeFileSync(join(root, 'one', 'two', 'skills', 'demo', 'SKILL.md'), '# demo');
      expect(discoverSkillFolders(root, 'project', 1).candidates.some(c => c.system === 'generic')).toBe(false);
      expect(discoverSkillFolders(root, 'project', 5, 1).truncated).toBe(true);
      expect(discoverSkillFolders(root, 'project', 5, 100, 1).truncated).toBe(true);
      expect(candidateDiscoveryDefaults.scanEntryLimit).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
