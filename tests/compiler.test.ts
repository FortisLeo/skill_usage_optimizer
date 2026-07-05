import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '../src/compiler/index.js';
import type { DiscoveryContext, NormalizedSkillInput } from '../src/types.js';
import { makeTempWorkspace, writeFixture } from './testUtils.js';

function makeInput(overrides: Partial<NormalizedSkillInput> = {}): NormalizedSkillInput {
  return {
    system: 'claude',
    kind: 'instruction_file',
    skillName: 'test-skill',
    description: null,
    rawMarkdown: '# Overview\n\nOverview content.\n\n## Setup\n\nSetup content.\n',
    frontmatter: {},
    attachments: [],
    sourcePath: '/tmp/test-skill.md',
    sourceHash: 'abc123',
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

describe('compile', () => {
  it('returns Map store with empty errors for good input', () => {
    const result = compile([makeInput()], makeCtx());
    expect(result.store).toBeInstanceOf(Map);
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBeGreaterThan(0);
  });

  it('produces deterministic IDs', () => {
    const input = makeInput({ skillName: 'deterministic', rawMarkdown: '# Setup\n\nContent.\n\n## Config\n\nConfig content.\n' });
    expect([...compile([input], makeCtx()).store.keys()].sort()).toEqual([...compile([input], makeCtx()).store.keys()].sort());
  });

  it('each section has id, title, content, and hash', () => {
    for (const [, s] of compile([makeInput()], makeCtx()).store) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(typeof s.content).toBe('string');
      expect(s.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(s.size).toBe(123);
    }
  });

  it('returns manifests alongside enriched compiled sections', () => {
    const result = compile([makeInput({ rawMarkdown: '# Overview\n\nMust read.\n\n## Links\n\n[repo](./README.md)\n' })], makeCtx());
    expect(result.manifests).toHaveLength(1);
    expect(result.manifests![0]).toMatchObject({ kind: 'instruction_file', description: null });
    expect(result.manifests![0]!.sections.map(s => s.class)).toEqual(['always', 'reference']);
    const first = [...result.store.values()][0]!;
    expect(first.policy?.alwaysInclude).toBe(true);
    expect(first.tokenCount).toBeGreaterThan(0);
    expect(result.manifests![0]!.sections[1]!.references).toEqual([{ target: './README.md', kind: 'file', resolved: false }]);
  });

  it('handles multiple inputs', () => {
    const result = compile([
      makeInput({ skillName: 'skill-a', rawMarkdown: '# A\n\nContent A.\n' }),
      makeInput({ skillName: 'skill-b', rawMarkdown: '# B\n\nContent B.\n' })
    ], makeCtx());
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBe(2);
  });

  it('captures bad input in errors array', () => {
    const badInput = makeInput({ sourcePath: '/tmp/bad.md' });
    (badInput as { rawMarkdown?: string }).rawMarkdown = undefined;
    const result = compile([badInput], makeCtx());
    expect(result.errors[0]!.path).toBe('/tmp/bad.md');
    expect(result.store).toBeDefined();
  });

  it('empty inputs produces empty store with no errors', () => {
    const result = compile([], makeCtx());
    expect(result.store.size).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('uses Instructions fallback for markdown without headings', () => {
    const result = compile([makeInput({ skillName: 'no-headings', rawMarkdown: 'Just some text without any headings.\n' })], makeCtx());
    expect(result.errors).toEqual([]);
    expect([...result.store.keys()]).toEqual(['claude::no-headings::abc123::instructions']);
  });

  it('compiles preamble before first heading as retrievable always section', () => {
    const md = 'Preamble text that must be loadable.\n\n# Overview\n\nOverview content.\n';
    const result = compile([makeInput({ skillName: 'preamble-test', rawMarkdown: md })], makeCtx());
    expect(result.errors).toEqual([]);
    // Should have 2 sections: preamble + overview
    expect(result.store.size).toBe(2);
    const preamble = [...result.store.values()].find(s => s.title === 'Preamble');
    expect(preamble).toBeDefined();
    expect(preamble!.content).toBe('Preamble text that must be loadable.');
    expect(preamble!.class).toBe('always');
    expect(preamble!.manifestId).toBe('claude::preamble-test::abc123');
  });

  it('preamble section ID is deterministic', () => {
    const input = makeInput({ skillName: 'det-pre', rawMarkdown: 'Preamble here.\n\n# Main\n\nContent.\n' });
    const ids1 = [...compile([input], makeCtx()).store.keys()];
    const ids2 = [...compile([input], makeCtx()).store.keys()];
    expect(ids1).toEqual(ids2);
    expect(ids1).toContain('claude::det-pre::abc123::preamble');
  });

  it('no preamble section when markdown has no headings (parser fallback used instead)', () => {
    const md = 'Just plain text.\n\nNo headings.\n';
    const result = compile([makeInput({ skillName: 'plain', rawMarkdown: md })], makeCtx());
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBe(1);
    expect([...result.store.keys()]).toEqual(['claude::plain::abc123::instructions']);
    // Should not include a Preamble section since parser already wrapped it
    expect([...result.store.values()].every(s => s.title !== 'Preamble')).toBe(true);
  });

  it('does not promote preamble when headings only exist inside fenced code blocks', () => {
    // All headings are inside fenced code blocks — parser sees no real headings
    // Should produce a single Instructions section, not a duplicate Preamble
    const md = '```\n# Fenced Heading\nSome code text.\n```\n\nPlain text after.';
    const result = compile([makeInput({ skillName: 'fenced-only', rawMarkdown: md })], makeCtx());
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBe(1);
    expect([...result.store.keys()]).toEqual(['claude::fenced-only::abc123::instructions']);
    expect([...result.store.values()].every(s => s.title !== 'Preamble')).toBe(true);
  });

  it('preserves sections from multiple inputs with different skillNames', () => {
    const commonMd = '# Overview\n\nSame overview content.\n';
    const inputs = [
      makeInput({ skillName: 'collide-a', rawMarkdown: commonMd, sourcePath: '/tmp/input-a.md' }),
      makeInput({ skillName: 'collide-b', rawMarkdown: commonMd, sourcePath: '/tmp/input-b.md' }),
    ];
    const result = compile(inputs, makeCtx());
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBe(2);
    const ids = [...result.store.keys()].sort();
    expect(ids).toContain('claude::collide-a::abc123::overview');
    expect(ids).toContain('claude::collide-b::abc123::overview');
  });

  it('preserves sections from three inputs with different skillNames', () => {
    const commonMd = '# Overview\n\nTriple collision content.\n';
    const inputs = [
      makeInput({ skillName: 'triple-1', rawMarkdown: commonMd, sourcePath: '/tmp/1.md' }),
      makeInput({ skillName: 'triple-2', rawMarkdown: commonMd, sourcePath: '/tmp/2.md' }),
      makeInput({ skillName: 'triple-3', rawMarkdown: commonMd, sourcePath: '/tmp/3.md' }),
    ];
    const result = compile(inputs, makeCtx());
    expect(result.errors).toEqual([]);
    expect(result.store.size).toBe(3);
    const ids = [...result.store.keys()].sort();
    expect(ids).toContain('claude::triple-1::abc123::overview');
    expect(ids).toContain('claude::triple-2::abc123::overview');
    expect(ids).toContain('claude::triple-3::abc123::overview');
  });

  describe('file reference resolution during compile', () => {
    it('resolves existing relative file ref within workspace root', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Overview\n\nSee [details](./details.md)\n');
        writeFileSync(join(root, '.claude/skills/details.md'), 'Extra details.', 'utf-8');
        const result = compile([makeInput({ skillName: 'ref-skill', rawMarkdown: '# Overview\n\nSee [details](./details.md)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const overview = [...result.store.values()].find(s => s.title === 'Overview');
        expect(overview).toBeDefined();
        expect(overview!.references).toHaveLength(1);
        expect(overview!.references![0]!.resolved).toBe(true);
        expect(overview!.references![0]!.absolutePath).toBeTruthy();
        expect(overview!.references![0]!.absolutePath!.endsWith('details.md')).toBe(true);
      } finally {
        cleanup();
      }
    });

    it('rejects traversal escape (../) as unresolved', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Setup\n\nRef [secret](../../etc/passwd)\n');
        const result = compile([makeInput({ skillName: 'escape-skill', rawMarkdown: '# Setup\n\nRef [secret](../../etc/passwd)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(false);
        expect(section.references![0]!.absolutePath).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('marks missing file as unresolved', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Links\n\nRef [missing](./no-such-file.md)\n');
        const result = compile([makeInput({ skillName: 'missing-skill', rawMarkdown: '# Links\n\nRef [missing](./no-such-file.md)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(false);
        expect(section.references![0]!.absolutePath).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('rejects absolute path outside allowed roots', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Config\n\nRef [/etc/hosts](/etc/hosts)\n');
        const result = compile([makeInput({ skillName: 'abs-skill', rawMarkdown: '# Config\n\nRef [/etc/hosts](/etc/hosts)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('rejects ref outside skill package boundary (sibling dir outside sourceDir)', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Overview\n\nSee [secret](../secret.md)\n');
        writeFileSync(join(root, '.claude/secret.md'), 'outside package.', 'utf-8');
        const result = compile([makeInput({ skillName: 'boundary-skill', rawMarkdown: '# Overview\n\nSee [secret](../secret.md)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('rejects ref outside skill package even with includeGlobals:true and broad homeDir', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        // file sits outside the .claude/skills/ dir but within workspace root
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Overview\n\nSee [outside](../../outside.md)\n');
        writeFileSync(join(root, 'outside.md'), 'outside content.', 'utf-8');
        const globCtx: DiscoveryContext = { ...ctx, includeGlobals: true };
        const result = compile([makeInput({ skillName: 'global-escape', rawMarkdown: '# Overview\n\nSee [outside](../../outside.md)\n', sourcePath: skillPath })], globCtx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('resolves valid ./details.md inside same skill package dir', () => {
      const { root, ctx, cleanup } = makeTempWorkspace();
      try {
        const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Overview\n\nSee [details](./details.md)\n');
        writeFileSync(join(root, '.claude/skills/details.md'), 'Valid details.', 'utf-8');
        const result = compile([makeInput({ skillName: 'valid-ref', rawMarkdown: '# Overview\n\nSee [details](./details.md)\n', sourcePath: skillPath })], ctx);
        expect(result.errors).toEqual([]);
        const section = [...result.store.values()][0]!;
        expect(section.references![0]!.resolved).toBe(true);
        expect(section.references![0]!.sourceRoot).toBeTruthy();
        expect(section.references![0]!.absolutePath!.endsWith('details.md')).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  describe('conflict resolution (same system::skillName)', () => {
    it('chooses winner by higher precedence', () => {
      const md1 = '# Overview\n\nHigher precedence.\n';
      const md2 = '# Overview\n\nLower precedence.\n';
      const inputs = [
        makeInput({ skillName: 'conflict', rawMarkdown: md2, sourcePath: '/tmp/low.md', precedence: 50 }),
        makeInput({ skillName: 'conflict', rawMarkdown: md1, sourcePath: '/tmp/high.md', precedence: 100 }),
      ];
      const result = compile(inputs, makeCtx());
      // Winner content comes from the higher-precedence input
      const overviewSection = [...result.store.values()].find(s => s.title === 'Overview');
      expect(overviewSection).toBeDefined();
      expect(overviewSection!.content).toBe('Higher precedence.');
      expect(result.manifests).toHaveLength(1);
    });

    it('diagnoses each dropped non-winner', () => {
      const inputs = [
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/a.md', precedence: 80 }),
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/b.md', precedence: 40 }),
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/c.md', precedence: 20 }),
      ];
      const result = compile(inputs, makeCtx());
      // a.md wins (precedence 80), b.md and c.md are losers
      const errorPaths = result.errors.map(e => e.path);
      expect(errorPaths).toContain('/tmp/b.md');
      expect(errorPaths).toContain('/tmp/c.md');
      expect(errorPaths).not.toContain('/tmp/a.md');
      for (const err of result.errors) {
        expect(err.error).toContain('conflict');
        expect(err.error).toContain('winner at /tmp/a.md');
      }
    });

    it('produces deterministic output independent of input order', () => {
      const makeInputs = () => [
        makeInput({ system: 'opencode', skillName: 'alpha', rawMarkdown: '# A\n\nAlpha.\n', sourcePath: '/tmp/oa.md', precedence: 80 }),
        makeInput({ system: 'claude', skillName: 'beta', rawMarkdown: '# B\n\nBeta.\n', sourcePath: '/tmp/cb.md', precedence: 80 }),
        makeInput({ system: 'claude', skillName: 'alpha', rawMarkdown: '# A\n\nAlpha claude.\n', sourcePath: '/tmp/ca.md', precedence: 80 }),
      ];
      const order1 = makeInputs();
      const order2 = [order1[2]!, order1[0]!, order1[1]!]; // reversed
      const r1 = compile(order1, makeCtx());
      const r2 = compile(order2, makeCtx());
      expect([...r1.store.keys()].sort()).toEqual([...r2.store.keys()].sort());
      expect(r1.manifests!.length).toBe(3);
      expect(r2.manifests!.length).toBe(3);
    });

    it('tiebreaks same precedence by sourcePath ascending', () => {
      const inputs = [
        makeInput({ skillName: 'tie', rawMarkdown: '# X\n\nSecond.\n', sourcePath: '/tmp/b.md', precedence: 80 }),
        makeInput({ skillName: 'tie', rawMarkdown: '# X\n\nFirst.\n', sourcePath: '/tmp/a.md', precedence: 80 }),
      ];
      const result = compile(inputs, makeCtx());
      expect([...result.store.values()].find(s => s.title === 'X')!.content).toBe('First.');
    });
  });
});

