import { describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadContext } from '../src/retrieval/context.js';
import { extractMarkdownLinks, extractReferences } from '../src/retrieval/references.js';
import type { SkillSection } from '../src/types.js';
import { makeTempWorkspace, writeFixture } from './testUtils.js';

function makeSection(overrides: Partial<SkillSection> = {}): SkillSection {
  return { id: 'test::section', title: 'Test Section', content: 'Some test content.', hash: 'abc123', ...overrides };
}

describe('loadContext', () => {
  it('empty query returns empty bundle', () => {
    const bundle = loadContext({ a: makeSection({ id: 'a', title: 'Alpha', content: 'Alpha content.' }) }, '');
    expect(bundle).toEqual({ sections: [], context: '' });
  });

  it('accepts Map and Record stores', () => {
    const mapBundle = loadContext(new Map([['a', makeSection({ id: 'a', title: 'Setup', content: 'Setup steps.' })]]), 'setup');
    expect(mapBundle.sections[0]!.id).toBe('a');
    const recordBundle = loadContext({ x: makeSection({ id: 'x', title: 'Examples', content: 'Example code.' }) }, 'examples');
    expect(recordBundle.sections[0]!.id).toBe('x');
  });

  it('non-empty query filters sections by title or content', () => {
    const store = {
      a: makeSection({ id: 'a', title: 'Setup', content: 'You need Node.js.' }),
      b: makeSection({ id: 'b', title: 'Usage', content: 'Usage guide.' }),
    };
    expect(loadContext(store, 'usage').sections[0]!.id).toBe('b');
    expect(loadContext(store, 'Node.js').sections[0]!.id).toBe('a');
  });

  it('context joins matching sections as markdown headings', () => {
    const bundle = loadContext({ a: makeSection({ id: 'a', title: 'Overview', content: 'Project overview.' }) }, 'overview');
    expect(bundle.context).toBe('# Overview\nProject overview.');
  });

  it('returns empty sections and empty context for empty store or no match', () => {
    expect(loadContext({}, 'anything')).toEqual({ sections: [], context: '' });
    expect(loadContext({ a: makeSection({ id: 'a', title: 'Overview', content: 'Overview.' }) }, 'missing')).toEqual({ sections: [], context: '' });
  });

  it('always includes always and mandatory policy sections without query match', () => {
    const bundle = loadContext({
      a: makeSection({ id: 'a', title: 'Overview', content: 'core', class: 'always', order: 0 }),
      p: makeSection({ id: 'p', title: 'Other', content: 'Never skip this', class: 'on_demand', policy: { lines: ['Never skip this'], alwaysInclude: true }, order: 1 }),
      x: makeSection({ id: 'x', title: 'Examples', content: 'optional', class: 'on_demand', order: 2 })
    }, { query: 'absent' });
    expect(bundle.sections.map(s => s.id)).toEqual(['a', 'p']);
  });

  it('within phase and on_demand classes query results are relevance ordered', () => {
    const bundle = loadContext({
      a: makeSection({ id: 'a', title: 'Overview', content: 'no match', class: 'always', order: 0 }),
      p1: makeSection({ id: 'p1', title: 'Deploy Steps', content: 'deploy deploy deploy deploy deploy deploy', class: 'phase', order: 1 }),
      p2: makeSection({ id: 'p2', title: 'Other Setup', content: 'deploy once', class: 'phase', order: 2 }),
      o1: makeSection({ id: 'o1', title: 'Deploy Examples', content: 'deploy deploy deploy deploy', class: 'on_demand', order: 3 }),
      o2: makeSection({ id: 'o2', title: 'Config Tips', content: 'deploy once', class: 'on_demand', order: 4 }),
    }, { query: 'deploy' });
    // always first, then phase relevance-ordered, then on_demand relevance-ordered
    expect(bundle.sections.map(s => s.id)).toEqual(['a', 'p1', 'p2', 'o1', 'o2']);
  });

  it('loads phase sections by requested phase', () => {
    const bundle = loadContext({
      setup: makeSection({ id: 'setup', title: 'Setup', content: 'install', class: 'phase' }),
      run: makeSection({ id: 'run', title: 'Run', content: 'execute', class: 'phase' })
    }, { phase: 'run' });
    expect(bundle.sections.map(s => s.id)).toEqual(['run']);
  });

  it('reports unresolved references only when requested', () => {
    const store = { a: makeSection({ id: 'a', title: 'Overview', content: 'See link', class: 'always', references: [{ target: 'https://example.com', kind: 'url' }] }) };
    expect(loadContext(store, { query: 'missing' }).references).toBeUndefined();
    const bundle = loadContext(store, { query: 'missing', includeReferences: true });
    expect(bundle.references).toEqual([{ ref: { target: 'https://example.com', kind: 'url', resolved: false } }]);
    expect(bundle.omitted).toContainEqual({ id: 'https://example.com', reason: 'reference_unresolved' });
  });

  it('orders reference-class sections after on_demand', () => {
    const bundle = loadContext({
      r: makeSection({ id: 'r', title: 'Ref Target', content: 'ref data', class: 'reference', order: 0 }),
      o: makeSection({ id: 'o', title: 'On Demand', content: 'deploy stuff', class: 'on_demand', order: 1 }),
    }, { query: 'deploy', includeReferences: true });
    const ids = bundle.sections.map(s => s.id);
    expect(ids.indexOf('o')).toBeLessThan(ids.indexOf('r'));
  });

  it('returns LoadedReference with content when reference target matches another section', () => {
    const store = {
      a: makeSection({ id: 'a', title: 'Overview', content: 'See details', class: 'always', references: [{ target: 'b', kind: 'file' }] }),
      b: makeSection({ id: 'b', title: 'Details', content: 'Detailed content here', class: 'reference' }),
    };
    const bundle = loadContext(store, { query: 'overview', includeReferences: true });
    expect(bundle.references).toEqual([
      { ref: { target: 'b', kind: 'file', resolved: true }, content: 'Detailed content here' },
    ]);
  });

  it('budget-omits index-resolved references when content exceeds remaining budget', () => {
    const bigContent = 'x'.repeat(500);
    const store = {
      a: makeSection({ id: 'a', title: 'Overview', content: 'main', class: 'always', byteLength: 4, order: 0, references: [{ target: 'b', kind: 'file' }] }),
      b: makeSection({ id: 'b', title: 'Ref Target', content: bigContent, class: 'reference', byteLength: 500 }),
    };
    const bundle = loadContext(store, { query: 'overview', includeReferences: true, maxBytes: 100 });
    expect(bundle.references).toHaveLength(1);
    expect(bundle.references![0]!.ref.resolved).toBe(true);
    expect(bundle.references![0]!.content).toBeUndefined();
    expect(bundle.omitted).toContainEqual({ id: 'b', reason: 'budget' });
  });

  it('mandatory sections survive tight maxBytes while optional sections drop', () => {
    const bundle = loadContext({
      alw: makeSection({ id: 'alw', title: 'always', content: 'always here.', class: 'always', byteLength: 12, order: 0 }),
      pol: makeSection({ id: 'pol', title: 'policy', content: 'policy mandatory', class: 'on_demand', policy: { lines: ['policy mandatory'], alwaysInclude: true }, byteLength: 16, order: 1 }),
      opt: makeSection({ id: 'opt', title: 'optional', content: 'optional content.', class: 'on_demand', byteLength: 17, order: 2 }),
    }, { query: 'optional', maxBytes: 1 });
    expect(bundle.sections.map(s => s.id)).toEqual(['alw', 'pol']);
    expect(bundle.omitted).toContainEqual({ id: 'opt', reason: 'budget' });
    // totalBytes includes mandatory sections even when exceeding maxBytes
    expect(bundle.totalBytes).toBe(28);
  });

  it('enforces maxBytes and records budget omissions', () => {
    const bundle = loadContext({
      a: makeSection({ id: 'a', title: 'Overview', content: '12345', class: 'always', byteLength: 5, order: 0 }),
      b: makeSection({ id: 'b', title: 'Implementation', content: 'deploy more', class: 'phase', byteLength: 11, order: 1 })
    }, { query: 'deploy', maxBytes: 6 });
    expect(bundle.sections.map(s => s.id)).toEqual(['a']);
    expect(bundle.totalBytes).toBe(5);
    expect(bundle.omitted).toContainEqual({ id: 'b', reason: 'budget' });
  });

  it('empty RetrievalRequest {} picks all sections as candidates in class order', () => {
    const store = {
      a: makeSection({ id: 'a', title: 'Always', content: 'core', class: 'always', order: 0 }),
      p: makeSection({ id: 'p', title: 'Phase', content: 'phase stuff', class: 'phase', order: 1 }),
      o: makeSection({ id: 'o', title: 'OnDemand', content: 'on demand stuff', class: 'on_demand', order: 2 }),
      r: makeSection({ id: 'r', title: 'Ref', content: 'ref stuff', class: 'reference', order: 3 }),
    };
    const bundle = loadContext(store, {});
    expect(bundle.sections.map(s => s.id)).toEqual(['a', 'p', 'o']);
    expect(bundle.omitted).toBeUndefined();
  });
});

describe('extractMarkdownLinks', () => {
  it('extracts markdown link URLs', () => {
    expect(extractMarkdownLinks('[Docs](https://example.com) and [local](./file.md "title")')).toEqual(['https://example.com', './file.md']);
  });

  it('types markdown references without reading files', () => {
    expect(extractReferences('[Docs](https://example.com) [Skill](skill:abc) [at](@skill/abc) [local](./file.md)')).toEqual([
      { target: 'https://example.com', kind: 'url' },
      { target: 'skill:abc', kind: 'skill' },
      { target: '@skill/abc', kind: 'skill' },
      { target: './file.md', kind: 'file' }
    ]);
  });
});

describe('file reference loading from disk', () => {
  it('loads resolved relative file ref content', () => {
    const { root, ctx, cleanup } = makeTempWorkspace();
    try {
      const refPath = writeFixture(root, 'docs/details.md', 'Extra content from file.');
      const skillPath = writeFixture(root, '.claude/skills/my-skill.md', '# Overview\n\nSee [details](../docs/details.md)\n');
      // resolveFileRefs is compile-time, so we build a store directly with a pre-resolved ref
      const store = {
        a: {
          id: 'a', title: 'Overview', content: 'See details', hash: 'abc',
          class: 'always' as const, order: 0,
          references: [{ target: '../docs/details.md', kind: 'file' as const, resolved: true, absolutePath: refPath }]
        },
      };
      const bundle = loadContext(store, { query: 'overview', includeReferences: true });
      expect(bundle.references).toHaveLength(1);
      expect(bundle.references![0]!.ref.resolved).toBe(true);
      expect(bundle.references![0]!.content).toBe('Extra content from file.');
      expect(bundle.omitted).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('loads resolved file ref only once when same path appears', () => {
    const { root, cleanup } = makeTempWorkspace();
    try {
      const refPath = writeFixture(root, 'docs/shared.md', 'Shared content.');
      const store = {
        a: {
          id: 'a', title: 'Section A', content: 'Ref shared', hash: 'abc',
          class: 'always' as const, order: 0,
          references: [
            { target: 'docs/shared.md', kind: 'file' as const, resolved: true, absolutePath: refPath },
            { target: 'docs/shared.md', kind: 'file' as const, resolved: true, absolutePath: refPath },
          ]
        },
      };
      const bundle = loadContext(store, { query: 'ref', includeReferences: true });
      // References are deduplicated by kind:target key
      expect(bundle.references).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('reports file ref as budget-omitted when content exceeds remaining budget', () => {
    const { root, cleanup } = makeTempWorkspace();
    try {
      const bigContent = 'x'.repeat(1000);
      const refPath = writeFixture(root, 'docs/big.md', bigContent);
      const store = {
        a: {
          id: 'a', title: 'Overview', content: 'main', hash: 'abc',
          class: 'always' as const, order: 0, byteLength: 4,
          references: [{ target: 'docs/big.md', kind: 'file' as const, resolved: true, absolutePath: refPath }]
        },
      };
      const bundle = loadContext(store, { query: 'overview', includeReferences: true, maxBytes: 100 });
      expect(bundle.references).toHaveLength(1);
      expect(bundle.references![0]!.ref.resolved).toBe(true);
      expect(bundle.references![0]!.content).toBeUndefined();
      expect(bundle.omitted).toContainEqual({ id: 'docs/big.md', reason: 'budget' });
    } finally {
      cleanup();
    }
  });

  it('reports unresolved file ref with reference_unresolved when file gone missing', () => {
    const { root, cleanup } = makeTempWorkspace();
    try {
      const missingPath = join(root, 'docs', 'gone.md');
      const store = {
        a: {
          id: 'a', title: 'Overview', content: 'link', hash: 'abc',
          class: 'always' as const, order: 0,
          references: [{ target: 'docs/gone.md', kind: 'file' as const, resolved: true, absolutePath: missingPath }]
        },
      };
      const bundle = loadContext(store, { query: 'overview', includeReferences: true });
      expect(bundle.references).toHaveLength(1);
      expect(bundle.references![0]!.ref.resolved).toBe(false);
      expect(bundle.references![0]!.content).toBeUndefined();
      expect(bundle.omitted).toContainEqual({ id: 'docs/gone.md', reason: 'reference_unresolved' });
    } finally {
      cleanup();
    }
  });

  it('loads resolved file refs even without explicit includeReferences flag', () => {
      const { root, cleanup } = makeTempWorkspace();
      try {
        const refPath = writeFixture(root, 'docs/info.md', 'info');
        const store = {
          a: {
            id: 'a', title: 'Overview', content: 'see more', hash: 'abc',
            class: 'always' as const, order: 0,
            references: [{ target: '../docs/info.md', kind: 'file' as const, resolved: true, absolutePath: refPath }]
          },
        };
        const bundle = loadContext(store, { query: 'overview' });
        // Resolved file refs load content regardless of includeReferences; only unresolved refs are gated
        expect(bundle.references).toHaveLength(1);
        expect(bundle.references![0]!.content).toBe('info');
      } finally {
        cleanup();
      }
    });

    it('rejects file ref when symlink swapped to outside sourceRoot after compile', () => {
      const { root, cleanup } = makeTempWorkspace();
      try {
        // Create a skill package dir and a valid ref file inside it
        const pkgDir = join(root, '.claude/skills/my-skill');
        const escapedPath = writeFixture(root, 'outside.txt', 'evil content');
        // Use writeFixture to ensure parent dirs exist
        const refPath = writeFixture(root, '.claude/skills/my-skill/details.md', 'safe content');
        // sourceRoot must be realpath'd to match compile-time behaviour (macOS /var vs /private/var)
        const sourceRoot = realpathSync(pkgDir);

        const store = {
          a: {
            id: 'a', title: 'Overview', content: 'see details', hash: 'abc',
            class: 'always' as const, order: 0,
            references: [{ target: 'details.md', kind: 'file' as const, resolved: true, absolutePath: refPath, sourceRoot }]
          },
        };

        // Before swap, loading works fine
        const before = loadContext(store, { query: 'overview', includeReferences: true });
        expect(before.references![0]!.content).toBe('safe content');

        // Swap the file with a symlink pointing outside sourceRoot
        unlinkSync(refPath);
        symlinkSync(escapedPath, refPath);

        // After swap, realpath resolves outside sourceRoot — must reject
        const after = loadContext(store, { query: 'overview', includeReferences: true });
        expect(after.references).toHaveLength(1);
        expect(after.references![0]!.ref.resolved).toBe(false);
        expect(after.references![0]!.content).toBeUndefined();
        expect(after.omitted).toContainEqual({ id: 'details.md', reason: 'reference_unresolved' });
      } finally {
        cleanup();
      }
    });
});
