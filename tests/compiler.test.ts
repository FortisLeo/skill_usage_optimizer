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
    const badInput = { ...makeInput({ sourcePath: '/tmp/bad.md' }) };
    // ponytail: deliberately produce a malformed input — rawMarkdown is required but missing
    delete (badInput as Partial<NormalizedSkillInput>).rawMarkdown;
    const result = compile([badInput as NormalizedSkillInput], makeCtx());
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
      expect(result.errors).toEqual([]);
    });

    it('emits shadowed inputs as diagnostics, not errors', () => {
      const inputs = [
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/a.md', precedence: 80 }),
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/b.md', precedence: 40 }),
        makeInput({ skillName: 'shared', rawMarkdown: '# A\n\nContent.\n', sourcePath: '/tmp/c.md', precedence: 20 }),
      ];
      const result = compile(inputs, makeCtx());
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics!.length).toBeGreaterThanOrEqual(1);
      // Only one diagnostic per conflict group
      expect(result.diagnostics!.length).toBe(1);
      const d = result.diagnostics![0]!;
      expect(d.conflictKey).toBe('claude::shared');
      expect(d.winnerPrecedence).toBe(80);
      expect(d.winner).toMatchObject({ system: 'claude', sourcePath: '/tmp/a.md' });
      expect(d.shadowed).toHaveLength(2);
      const shadowedPaths = d.shadowed.map(s => s.sourcePath).sort();
      expect(shadowedPaths).toEqual(['/tmp/b.md', '/tmp/c.md']);
      expect(d.reason).toBe('higher_precedence');
    });

    it('attaches precedence and conflicts to winner manifest', () => {
      const inputs = [
        makeInput({ skillName: 'attach', rawMarkdown: '# X\n\nWinner.\n', sourcePath: '/tmp/win.md', precedence: 90 }),
        makeInput({ skillName: 'attach', rawMarkdown: '# X\n\nLoser.\n', sourcePath: '/tmp/lose.md', precedence: 30 }),
      ];
      const result = compile(inputs, makeCtx());
      expect(result.manifests).toHaveLength(1);
      const m = result.manifests![0]!;
      expect(m.precedence).toBe(90);
      expect(m.conflicts).toBeDefined();
      expect(m.conflicts).toHaveLength(1);
      expect(m.conflicts![0]!.conflictKey).toBe('claude::attach');
      expect(m.conflicts![0]!.winner.sourcePath).toBe('/tmp/win.md');
      expect(m.conflicts![0]!.shadowed).toHaveLength(1);
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
      expect(r1.errors).toEqual([]);
      expect(r2.errors).toEqual([]);
    });

    it('tiebreaks same precedence by sourcePath ascending', () => {
      const inputs = [
        makeInput({ skillName: 'tie', rawMarkdown: '# X\n\nSecond.\n', sourcePath: '/tmp/b.md', precedence: 80 }),
        makeInput({ skillName: 'tie', rawMarkdown: '# X\n\nFirst.\n', sourcePath: '/tmp/a.md', precedence: 80 }),
      ];
      const result = compile(inputs, makeCtx());
      expect([...result.store.values()].find(s => s.title === 'X')!.content).toBe('First.');
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics![0]!.reason).toBe('same_precedence_tiebreak');
      expect(result.diagnostics![0]!.winner.sourcePath).toBe('/tmp/a.md');
    });

    it('tiebreaks same precedence and same sourcePath by sourceHash ascending', () => {
      const inputs = [
        makeInput({ skillName: 'hash-tie', rawMarkdown: '# H\n\nHash-B.\n', sourcePath: '/tmp/shared.md', sourceHash: 'bbb222', precedence: 80 }),
        makeInput({ skillName: 'hash-tie', rawMarkdown: '# H\n\nHash-A.\n', sourcePath: '/tmp/shared.md', sourceHash: 'aaa111', precedence: 80 }),
      ];
      const result = compile(inputs, makeCtx());
      expect([...result.store.values()].find(s => s.title === 'H')!.content).toBe('Hash-A.');
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics![0]!.reason).toBe('same_precedence_tiebreak');
      expect(result.diagnostics![0]!.winner.sourceHash).toBe('aaa111');
    });

    it('same skillName different system both compile (no conflict)', () => {
      const inputs = [
        makeInput({ system: 'claude', skillName: 'shared', rawMarkdown: '# C\n\nClaude.\n', sourcePath: '/tmp/claude.md', precedence: 80 }),
        makeInput({ system: 'opencode', skillName: 'shared', rawMarkdown: '# O\n\nOpencode.\n', sourcePath: '/tmp/open.md', precedence: 50 }),
      ];
      const result = compile(inputs, makeCtx());
      expect(result.manifests).toHaveLength(2);
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.store.size).toBe(2);
    });

    it('keeps generic and known same-name skills isolated with generic IDs', () => {
      const result = compile([
        makeInput({ system: 'generic', skillName: 'shared', sourcePath: '/tmp/generic.md', sourceHash: 'aaa11111' }),
        makeInput({ system: 'claude', skillName: 'shared', sourcePath: '/tmp/claude.md', sourceHash: 'bbb22222' })
      ], makeCtx());
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.manifests!.map(manifest => manifest.id).sort()).toEqual(['claude::shared::bbb22222', 'generic::shared::aaa11111']);
    });

    it('no diagnostics or errors for single input (no conflict possible)', () => {
      const result = compile([makeInput({ skillName: 'solo' })], makeCtx());
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toEqual([]);
      expect(result.manifests).toHaveLength(1);
    });

    it('only shadowed inputs are excluded from store, not winners', () => {
      const inputs = [
        makeInput({ skillName: 'part', rawMarkdown: '# P\n\nWin.\n', sourcePath: '/tmp/win.md', precedence: 100 }),
        makeInput({ skillName: 'part', rawMarkdown: '# P\n\nShadow.\n', sourcePath: '/tmp/shadow.md', precedence: 30 }),
        makeInput({ skillName: 'other', rawMarkdown: '# O\n\nOther.\n', sourcePath: '/tmp/other.md', precedence: 50 }),
      ];
      const result = compile(inputs, makeCtx());
      // 'other' is a different skillName so it compiles; 'part' only winner compiles
      expect(result.store.size).toBe(2);
      expect([...result.store.values()].map(s => s.content)).toContain('Win.');
      expect([...result.store.values()].map(s => s.content)).toContain('Other.');
      expect(result.manifests).toHaveLength(2);
      expect(result.errors).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
    });
  });
});
