import { describe, expect, it } from 'vitest';
import { buildManifest, buildSections } from '../src/compiler/manifest.js';
import type { DiscoveryContext, NormalizedSkillInput } from '../src/types.js';

function makeFixtureInput(overrides: Partial<NormalizedSkillInput> = {}): NormalizedSkillInput {
  return {
    system: 'claude',
    kind: 'instruction_file',
    skillName: 'test-skill',
    description: 'A test skill',
    rawMarkdown: '# Overview\n\nOverview content.\n\n## Setup\n\nSetup content.\n\n## Usage\n\nUsage content.\n',
    frontmatter: {},
    attachments: [],
    sourcePath: '/tmp/test-skill.md',
    sourceHash: 'abcdef123456',
    mtimeMs: 1000,
    size: 123,
    precedence: 80,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    workspaceRoot: '/tmp/test-workspace',
    repoRoot: null,
    homeDir: '/tmp/test-home',
    includeGlobals: false,
    includeSystem: false,
    explicitRoots: [],
    ...overrides,
  };
}

function noCollisions(): Map<string, number> {
  return new Map();
}

describe('buildSections', () => {
  it('builds sections from NormalizedSkillInput', () => {
    const sections = buildSections(makeFixtureInput(), makeCtx(), noCollisions());
    expect(sections.map(s => s.title)).toContain('Overview');
  });

  it('assigns deterministic IDs to sections', () => {
    const input = makeFixtureInput({ rawMarkdown: '# Overview\n\nContent.\n\n## Setup\n\nSetup content.\n' });
    expect(buildSections(input, makeCtx(), noCollisions()).map(s => s.id)).toEqual(buildSections(input, makeCtx(), noCollisions()).map(s => s.id));
  });

  it('computes content hash for each section', () => {
    for (const s of buildSections(makeFixtureInput(), makeCtx(), noCollisions())) {
      expect(s.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('copies source metadata onto sections', () => {
    expect(buildSections(makeFixtureInput(), makeCtx(), noCollisions())[0]).toMatchObject({
      system: 'claude',
      sourcePath: '/tmp/test-skill.md',
      sourceHash: 'abcdef123456',
      mtimeMs: 1000,
      size: 123
    });
  });

  it('section content matches input markdown', () => {
    const sections = buildSections(makeFixtureInput({ rawMarkdown: '# Overview\n\nThis is overview content.\n' }), makeCtx(), noCollisions());
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toContain('This is overview content.');
  });

  it('uses heading path for nested section IDs', () => {
    const sections = buildSections(makeFixtureInput({ rawMarkdown: '# A\n\nContent A.\n\n## B\n\nContent B.\n' }), makeCtx(), noCollisions());
    expect(sections.map(s => s.id)).toEqual(['claude::test-skill::abcdef12::a', 'claude::test-skill::abcdef12::a--b']);
  });

  it('falls back to Instructions for markdown without headings', () => {
    const sections = buildSections(makeFixtureInput({ rawMarkdown: 'Plain instructions.' }), makeCtx(), noCollisions());
    expect(sections[0]).toMatchObject({ id: 'claude::test-skill::abcdef12::instructions', title: 'Instructions', content: 'Plain instructions.' });
  });

  it('enriches sections with class, policy, references, token and byte metadata', () => {
    const sections = buildSections(makeFixtureInput({ rawMarkdown: '# Overview\n\nAlways read this. See [docs](https://example.com).\n\n## Examples\n\nUse as needed.\n' }), makeCtx(), noCollisions());
    expect(sections[0]).toMatchObject({ class: 'always', manifestId: 'claude::test-skill::abcdef12', order: 0 });
    expect(sections[0]!.policy).toMatchObject({ alwaysInclude: true, lines: ['Always read this. See [docs](https://example.com).'] });
    expect(sections[0]!.references).toEqual([{ target: 'https://example.com', kind: 'url' }]);
    expect(sections[0]!.tokenCount).toBeGreaterThan(0);
    expect(sections[0]!.byteLength).toBe(Buffer.byteLength(sections[0]!.content, 'utf-8'));
    expect(sections[1]!.class).toBe('on_demand');
  });

  it('builds a manifest from enriched sections', () => {
    const input = makeFixtureInput({ rawMarkdown: '# Overview\n\nMust read.\n\n## References\n\n[local](./file.md)\n' });
    const sections = buildSections(input, makeCtx(), noCollisions());
    const manifest = buildManifest(input, sections);
    expect(manifest).toMatchObject({ id: 'claude::test-skill::abcdef12', skillName: 'test-skill', kind: 'instruction_file', description: 'A test skill', sourceHash: 'abcdef123456' });
    expect(manifest.sections.map(s => s.class)).toEqual(['always', 'reference']);
    expect(manifest.sections[1]!.references).toEqual([{ target: './file.md', kind: 'file', resolved: false }]);
    expect(manifest.tokenCount).toBe(sections.reduce((sum, s) => sum + s.tokenCount!, 0));
  });
});
