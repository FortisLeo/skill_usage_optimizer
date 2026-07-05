// ponytail: integration test — FileStore + handlers end-to-end
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore, SkillSection } from '../src/store/fileStore.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import {
  handleIndexSkills,
  handleListSkills,
  handleGetSkillManifest,
  handleGetSkillSections,
  handleLoadSection
} from '../src/mcp/tools.js';
import { computeHash } from '../src/fs/freshness.js';

function withSource(section: SkillSection, dir: string): SkillSection {
  const sourcePath = join(dir, `${section.id}.md`);
  writeFileSync(sourcePath, section.content, 'utf-8');
  const stat = statSync(sourcePath);
  return { ...section, system: 'claude', sourcePath, sourceHash: computeHash(section.content), mtimeMs: stat.mtimeMs, size: stat.size };
}

describe('integration: FileStore + tool handlers', () => {
  let dir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'integration-test-'));
    fileStore = new FileStore(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('writes and reads sections through the store', async () => {
    const section: SkillSection = { id: 'skill-1', title: 'Test', content: '# Test', hash: 'h1' };
    const m = new Map<string, SkillSection>();
    m.set('skill-1', section);
    await fileStore.writeSections(m);
    await fileStore.writeIndex({ 'skill-1': 'h1' });

    const index = await fileStore.readIndex();
    expect(index['skill-1']).toBe('h1');

    const sections = await fileStore.readSections(['skill-1']);
    expect(sections.get('skill-1')).toEqual(section);
  });

  it('full index_skills pipeline writes sections then index', async () => {
    const section: SkillSection = { id: 'pipeline-skill', title: 'Pipe', content: '# Pipe', hash: 'ph' };
    const deps: ToolDeps = {
      discover: () => ({ artifacts: [], errors: [] }),
      normalize: () => ({ inputs: [], errors: [] }),
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('pipeline-skill', section);
        return { store, errors: [] };
      },
      loadContext: () => ({ sections: [], context: '' }),
      store: fileStore,
      resolveHomeDir: () => '/fake/home',
      resolveWorkspaceRoot: () => '/fake/ws'
    };

    const result = await handleIndexSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.indexedSections).toBe(1);

    // Verify index was written
    const index = await fileStore.readIndex();
    expect(index['pipeline-skill']).toBe('ph');
  });

  it('load_section detects duplicate refs from store', async () => {
    const section: SkillSection = withSource({
      id: 'dup-skill',
      title: 'Dup',
      content: '# Dups\n[[a]] and [[a]] and also [[a]]',
      hash: 'dh'
    }, dir);
    const m = new Map<string, SkillSection>();
    m.set('dup-skill', section);
    await fileStore.writeSections(m);
    await fileStore.writeIndex({ 'dup-skill': 'dh' });

    const deps: ToolDeps = {
      discover: () => ({ artifacts: [], errors: [] }),
      normalize: () => ({ inputs: [], errors: [] }),
      compile: () => ({ store: new Map(), errors: [] }),
      loadContext: () => ({ sections: [], context: '' }),
      store: fileStore,
      resolveHomeDir: () => '/fake/home',
      resolveWorkspaceRoot: () => '/fake/ws'
    };

    const result = await handleLoadSection(deps, 'dup-skill');
    const parsed = JSON.parse(result);
    expect(parsed.duplicateRefs).toBeDefined();
    expect(parsed.duplicateRefs.length).toBe(1);
    expect(parsed.duplicateRefs[0]).toContain('3x');
  });

  it('multi-section integration flow: list -> manifest -> sections -> load_section', async () => {
    const manifest: import('../src/types.js').SkillManifest = {
      id: 'integ-test',
      skillName: 'integration-test-skill',
      system: 'claude',
      sourcePath: join(dir, 'test-skill.md'),
      sourceHash: 'sh123456',
      sections: [
        { id: 'integ-test::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 },
        { id: 'integ-test::setup', title: 'Setup', class: 'phase', tokenCount: 3, byteLength: 12, references: [], order: 1 }
      ],
      tokenCount: 6,
      byteLength: 27
    };
    const s1: SkillSection = withSource({
      id: 'integ-test::overview',
      title: 'Overview',
      content: '# Overview\nIntegration test overview.',
      hash: 'h1',
      manifestId: 'integ-test'
    }, dir);
    const s2: SkillSection = withSource({
      id: 'integ-test::setup',
      title: 'Setup',
      content: '# Setup\nSetup instructions.',
      hash: 'h2',
      manifestId: 'integ-test'
    }, dir);
    const m = new Map<string, SkillSection>();
    m.set('integ-test::overview', s1);
    m.set('integ-test::setup', s2);
    await fileStore.writeSections(m);
    await fileStore.writeIndex({ 'integ-test::overview': 'h1', 'integ-test::setup': 'h2' });
    await fileStore.writeManifests({ 'integ-test': manifest });

    const deps: import('../src/mcp/tools.js').ToolDeps = {
      discover: () => ({ artifacts: [], errors: [] }),
      normalize: () => ({ inputs: [], errors: [] }),
      compile: () => ({ store: new Map(), errors: [] }),
      loadContext: () => ({ sections: [], context: '' }),
      store: fileStore,
      resolveHomeDir: () => '/fake/home',
      resolveWorkspaceRoot: () => '/fake/ws'
    };

    // 1. list_skills
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.count).toBe(1);
    expect(list.skills[0].id).toBe('integ-test');
    expect(list.skills[0].skillName).toBe('integration-test-skill');
    expect(list.skills[0].sectionCount).toBe(2);

    // 2. get_skill_manifest
    const got = JSON.parse(await handleGetSkillManifest(deps, 'integ-test'));
    expect(got.exists).toBe(true);
    expect(got.sections).toHaveLength(2);
    expect(got.sections.map((s: { id: string }) => s.id).sort())
      .toEqual(['integ-test::overview', 'integ-test::setup']);

    // 3. get_skill_sections
    const gotSections = JSON.parse(await handleGetSkillSections(deps, 'integ-test'));
    expect(gotSections.sections).toHaveLength(2);

    // 4. load_section on a specific section
    const sec = JSON.parse(await handleLoadSection(deps, 'integ-test::overview'));
    expect(sec.section.id).toBe('integ-test::overview');
    expect(sec.section.content).toContain('Integration test overview');
  });
});
