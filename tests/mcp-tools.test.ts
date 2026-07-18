// ponytail: MCP tool handler unit tests with stub deps
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import type { DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic, NormalizedSkillInput, SkillConflictDiagnostic, SkillManifest } from '../src/types.js';
import { FileStore, type SkillSection } from '../src/store/fileStore.js';
import { computeHash } from '../src/fs/freshness.js';
import { discover } from '../src/discovery/index.js';
import { normalize } from '../src/normalize/index.js';
import { compile } from '../src/compiler/index.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import {
  handleIndexSkills,
  handleListSkills,
  handleGetSkillManifest,
  handleGetSkillSections,
  handleLoadSkillContext,
  handleLoadSection,
  handleSearchSkillSections,
  handleResolveTaskSections
} from '../src/mcp/tools.js';

const tempFiles = mkdtempSync(join(tmpdir(), 'mcp-tools-'));
const execFileAsync = promisify(execFile);
afterAll(() => rmSync(tempFiles, { recursive: true, force: true }));

function makeSection(id: string, content: string, hash?: string, system: SkillSection['system'] = 'claude', manifestId?: string): SkillSection {
  const sourcePath = join(tempFiles, Buffer.from(id + Math.random()).toString('base64url') + '.md');
  writeFileSync(sourcePath, content, 'utf-8');
  const stat = statSync(sourcePath);
  return { id, title: id.toUpperCase(), content, hash: hash ?? 'h_' + id, system, sourcePath, sourceHash: computeHash(content), mtimeMs: stat.mtimeMs, size: stat.size, manifestId };
}

function makeArtifact(system: DiscoveredArtifact['system'], absolutePath = `/tmp/${system}.md`): DiscoveredArtifact {
  return { system, kind: 'instruction_file', absolutePath, relativePath: absolutePath, rootOrigin: '/tmp', precedence: 80, configIndirection: null, rawStat: { mtimeMs: 1, size: 2 } };
}

function makeManifest(id: string, section: SkillSection, system: SkillManifest['system'] = 'claude'): SkillManifest {
  return {
    id, skillName: id, system, kind: 'instruction_file', description: null,
    sourcePath: section.sourcePath!, sourceHash: section.sourceHash!,
    sections: [{ id: section.id, title: section.title, class: 'always', tokenCount: 1, byteLength: section.content.length, references: [], order: 0 }],
    tokenCount: 1, byteLength: section.content.length
  };
}

function makeStoreDeps(initialIndex?: Record<string, string>, initialSections?: SkillSection[], initialManifests?: Record<string, SkillManifest>) {
  let index: Record<string, string> = { ...initialIndex };
  const sections = new Map<string, SkillSection>();
  if (initialSections) {
    for (const s of initialSections) {
      sections.set(s.id, s);
    }
  }
  let manifests: Record<string, SkillManifest> = { ...initialManifests };
  return {
    readIndex: async () => ({ ...index }),
    writeIndex: async (entries: Record<string, string>) => { index = { ...entries }; },
    readSections: async (ids: string[]) => {
      const result = new Map<string, SkillSection>();
      for (const id of ids) {
        const s = sections.get(id);
        if (s) result.set(id, s);
      }
      return result;
    },
    writeSections: async (m: Map<string, SkillSection>) => {
      m.forEach((s, id) => sections.set(id, s));
    },
    readManifests: async () => ({ ...manifests }),
    writeManifests: async (m: Record<string, SkillManifest>) => { manifests = { ...m }; },
    clear: async () => { index = {}; sections.clear(); manifests = {}; }
  };
}

function makeStubDeps(overrides?: Partial<ToolDeps>): ToolDeps {
  return {
    discover: () => ({ artifacts: [], errors: [] }),
    normalize: () => ({ inputs: [], errors: [] }),
    compile: () => ({ store: new Map(), errors: [] }),
    loadContext: () => ({ sections: [], context: '' }),
    store: makeStoreDeps(),
    resolveHomeDir: () => '/fake/home',
    resolveWorkspaceRoot: () => '/fake/ws',
    ...overrides
  };
}

describe('handleIndexSkills', () => {
  const discoveryDiagnostic: DiscoveryDiagnostic = {
    environment: 'claude', capability: 'roots', sourceType: 'explicit', status: 'limited',
    code: 'SOURCE_UNSAFE', foundCount: 1, skippedCount: 1,
    limitation: 'Unsafe entries were skipped.',
    explicitRootGuidance: 'Pass trusted directories in index_skills.roots.'
  };

  it('indexes with no artifacts', async () => {
    const deps = makeStubDeps();
    const result = await handleIndexSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.indexedSkills).toBe(0);
    expect(parsed.indexedSections).toBe(0);
  });

  it('indexes artifacts through pipeline', async () => {
    const section = makeSection('skill-1', '# Hello', 'hash1');
    const deps = makeStubDeps({
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('skill-1', section);
        return { store, errors: [] };
      }
    });
    const result = await handleIndexSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.indexedSections).toBe(1);

    // Verify index was written
    const idx = await deps.store.readIndex();
    expect(idx['skill-1']).toBe('hash1');
  });

  it('reports discovery errors', async () => {
    const deps = makeStubDeps({
      discover: () => ({ artifacts: [], errors: [{ path: 'discover:claude', error: 'test error' }] })
    });
    const result = await handleIndexSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('test error');
  });

  it('requested adapter failure preserves live records without writes', async () => {
    const old = makeSection('old', '# Old', 'old-hash', 'claude', 'old-manifest');
    const manifest = makeManifest('old-manifest', old);
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [manifest.id]: manifest });
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({
      store,
      discover: () => ({ artifacts: [], errors: [{ path: 'discover:claude', error: 'adapter failed' }] })
    });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors).toEqual(['discover:claude: adapter failed']);
    expect(writes).toBe(0);
    expect(await store.readIndex()).toEqual({ [old.id]: old.hash });
    expect(await store.readManifests()).toEqual({ [manifest.id]: manifest });
  });

  it('force replaces target without early clear', async () => {
    const events: string[] = [];
    const old = makeSection('old', '# Old');
    const baseStore = makeStoreDeps({ old: old.hash }, [old]);
    baseStore.clear = async () => { events.push('clear'); };
    const store = { ...baseStore, withIndexLock: async <T>(action: () => Promise<T>) => { events.push('lock'); return action(); } };
    const deps = makeStubDeps({
      store,
      compile: () => { events.push('compile'); return { store: new Map(), errors: [] }; }
    });
    await handleIndexSkills(deps, 'claude', undefined, undefined, true);
    const idx = await deps.store.readIndex();
    expect(idx['old']).toBeUndefined();
    expect(events).toEqual(['compile', 'lock']);
  });

  it('force compile failure preserves prior live files', async () => {
    const old = makeSection('old', '# Old', 'old-hash');
    const oldManifest = makeManifest('old-manifest', old);
    const store = makeStoreDeps({ old: old.hash }, [old], { [oldManifest.id]: oldManifest });
    const deps = makeStubDeps({
      store,
      compile: () => ({ store: new Map(), errors: [{ path: 'compile', error: 'broken' }] })
    });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude', undefined, undefined, true)).errors).toEqual(['compile: broken']);
    expect(await store.readIndex()).toEqual({ old: old.hash });
    expect(await store.readSections(['old'])).toEqual(new Map([['old', old]]));
    expect(await store.readManifests()).toEqual({ [oldManifest.id]: oldManifest });
  });

  it('force write failure restores prior requested-system records', async () => {
    const old = makeSection('old', '# Same', 'same-hash', 'claude', 'same-manifest');
    const incoming = { ...old, mtimeMs: old.mtimeMs! + 1 };
    const manifest = makeManifest('same-manifest', old);
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [manifest.id]: manifest });
    store.writeIndex = async () => { throw new Error('index write failed'); };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [manifest] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude', undefined, undefined, true)).errors[0]).toContain('index write failed');
    expect(await store.readIndex()).toEqual({ [old.id]: old.hash });
    expect(await store.readSections([old.id])).toEqual(new Map([[old.id, old]]));
    expect(await store.readManifests()).toEqual({ [manifest.id]: manifest });
  });

  it('reuses identical records normally and rewrites them with force without changing live state', async () => {
    const incoming = makeSection('same', '# Same', 'same-hash', 'claude', 'same-manifest');
    const other = makeSection('other', '# Other', 'other-hash', 'opencode', 'other-manifest');
    const incomingManifest = makeManifest('same-manifest', incoming);
    const otherManifest = makeManifest('other-manifest', other, 'opencode');
    const run = async (force: boolean) => {
      const store = makeStoreDeps(
        { [incoming.id]: incoming.hash, [other.id]: other.hash },
        [incoming, other],
        { [incomingManifest.id]: incomingManifest, [otherManifest.id]: otherManifest }
      );
      const writes: SkillSection[][] = [];
      const writeSections = store.writeSections;
      store.writeSections = async sections => { writes.push([...sections.values()]); await writeSections(sections); };
      const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] }) });
      expect(JSON.parse(await handleIndexSkills(deps, 'claude', undefined, undefined, force)).errors).toEqual([]);
      return { writes, index: await store.readIndex(), sections: await store.readSections([incoming.id, other.id]), manifests: await store.readManifests() };
    };

    const ordinary = await run(false);
    const forced = await run(true);
    expect(ordinary.writes).toEqual([[]]);
    expect(forced.writes).toEqual([[incoming]]);
    expect(forced.index).toEqual(ordinary.index);
    expect(forced.sections).toEqual(ordinary.sections);
    expect(forced.manifests).toEqual(ordinary.manifests);
    expect(forced.sections.get(other.id)).toEqual(other);
    expect(forced.manifests[otherManifest.id]).toEqual(otherManifest);
  });

  it('force replaces only the requested system', async () => {
    const oldTarget = makeSection('old-target', '# Old', 'old-target-hash', 'claude', 'old-target-manifest');
    const other = makeSection('other', '# Other', 'other-hash', 'opencode', 'other-manifest');
    const incoming = makeSection('new-target', '# New', 'new-target-hash', 'claude', 'new-target-manifest');
    const otherManifest = makeManifest('other-manifest', other, 'opencode');
    const incomingManifest = makeManifest('new-target-manifest', incoming);
    const store = makeStoreDeps(
      { [oldTarget.id]: oldTarget.hash, [other.id]: other.hash },
      [oldTarget, other],
      { 'old-target-manifest': makeManifest('old-target-manifest', oldTarget), [otherManifest.id]: otherManifest }
    );
    const deps = makeStubDeps({
      store,
      compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] })
    });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude', undefined, undefined, true)).errors).toEqual([]);
    expect(await store.readIndex()).toEqual({ [other.id]: other.hash, [incoming.id]: incoming.hash });
    expect(await store.readManifests()).toEqual({ [otherManifest.id]: otherManifest, [incomingManifest.id]: incomingManifest });
  });

  it('normalization failure performs no writes', async () => {
    const store = makeStoreDeps({ old: 'old-hash' });
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({
      store,
      normalize: () => ({ inputs: [], errors: [{ path: 'normalize', error: 'broken' }] })
    });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors).toEqual(['normalize: broken']);
    expect(writes).toBe(0);
    expect(await store.readIndex()).toEqual({ old: 'old-hash' });
  });

  it('section collision aborts before live switch', async () => {
    const old = makeSection('shared-id', '# Old', 'old-hash', 'opencode');
    const incoming = makeSection('shared-id', '# New', 'new-hash', 'claude');
    const store = makeStoreDeps({ [old.id]: old.hash }, [old]);
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors[0]).toContain('section ID collision');
    expect(writes).toBe(0);
    expect(await store.readIndex()).toEqual({ [old.id]: old.hash });
  });

  it('refreshes harmless section metadata instead of reusing the stale physical record', async () => {
    const old = makeSection('refresh', '# Same', 'same-hash', 'claude');
    const incoming = { ...old, mtimeMs: old.mtimeMs! + 1, precedence: 100 };
    const store = makeStoreDeps({ [old.id]: old.hash }, [old]);
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors).toEqual([]);
    expect((await store.readSections([incoming.id])).get(incoming.id)).toEqual(incoming);
  });

  it('manifest ID collision aborts before any writes or live switch', async () => {
    const old = makeSection('shared-section', '# Same', 'same-hash', 'claude', 'shared-manifest');
    const incoming = makeSection('shared-section', '# Same', 'same-hash', 'claude', 'shared-manifest');
    const oldManifest = { ...makeManifest('shared-manifest', old), sourceHash: '12345678-old' };
    const incomingManifest = { ...makeManifest('shared-manifest', incoming), sourceHash: '12345678-new' };
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [oldManifest.id]: oldManifest });
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors[0]).toContain('manifest ID collision');
    expect(writes).toBe(0);
    expect(await store.readIndex()).toEqual({ [old.id]: old.hash });
  });

  it('accepts a canonical source path alias for the same manifest identity', async () => {
    const old = makeSection('alias-section', '# Same', 'same-hash', 'claude', 'alias-manifest');
    const alias = join(tempFiles, `source-alias-${Math.random()}.md`);
    symlinkSync(old.sourcePath!, alias);
    const incoming = { ...old, sourcePath: alias };
    const oldManifest = makeManifest('alias-manifest', old);
    const incomingManifest = { ...oldManifest, sourcePath: alias };
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [oldManifest.id]: oldManifest });
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors).toEqual([]);
    expect((await store.readSections([incoming.id])).get(incoming.id)?.sourcePath).toBe(alias);
  });

  it.each([
    ['provenance', (manifest: SkillManifest) => ({ ...manifest, sourceHash: manifest.sourceHash + '-changed' })],
    ['section references', (manifest: SkillManifest) => ({ ...manifest, sections: [{ ...manifest.sections[0]!, id: 'different-section' }] })]
  ] as const)('rejects manifest %s mismatch before writes', async (_label, change) => {
    const old = makeSection('manifest-section', '# Same', 'same-hash', 'claude', 'shared-manifest');
    const oldManifest = makeManifest('shared-manifest', old);
    const incomingManifest = change(makeManifest('shared-manifest', old));
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [oldManifest.id]: oldManifest });
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[old.id, old]]), errors: [], manifests: [incomingManifest] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors[0]).toContain('manifest ID collision');
    expect(writes).toBe(0);
  });

  it('stages merged manifests before switching index and cleans stale manifests afterward', async () => {
    const old = makeSection('old-section', '# Old', 'old-hash', 'claude', 'old-manifest');
    const other = makeSection('other-section', '# Other', 'other-hash', 'opencode', 'other-manifest');
    const incoming = makeSection('new-section', '# New', 'new-hash', 'claude', 'new-manifest');
    const oldManifest = makeManifest('old-manifest', old);
    const otherManifest = makeManifest('other-manifest', other, 'opencode');
    const incomingManifest = makeManifest('new-manifest', incoming);
    const store = makeStoreDeps({ [old.id]: old.hash, [other.id]: other.hash }, [old, other], { [oldManifest.id]: oldManifest, [otherManifest.id]: otherManifest });
    const events: string[] = [];
    const writeSections = store.writeSections;
    const writeManifests = store.writeManifests;
    const writeIndex = store.writeIndex;
    store.writeSections = async sections => { events.push('sections'); await writeSections(sections); };
    store.writeManifests = async manifests => { events.push(`manifests:${Object.keys(manifests).sort().join(',')}`); await writeManifests(manifests); };
    store.writeIndex = async index => { events.push(`index:${Object.keys(index).sort().join(',')}`); await writeIndex(index); };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] }) });

    await handleIndexSkills(deps, 'claude');
    expect(events).toEqual([
      'sections',
      'manifests:new-manifest,old-manifest,other-manifest',
      'index:new-section,other-section',
      'manifests:new-manifest,other-manifest'
    ]);
  });

  it('pre-switch write failure leaves the prior index authoritative', async () => {
    const old = makeSection('old', '# Old', 'old-hash', 'opencode');
    const incoming = makeSection('new', '# New', 'new-hash', 'claude');
    const store = makeStoreDeps({ [old.id]: old.hash }, [old]);
    store.writeSections = async () => { throw new Error('disk full'); };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [] }) });

    expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors[0]).toContain('disk full');
    expect(await store.readIndex()).toEqual({ [old.id]: old.hash });
  });

  it('post-switch stale-manifest cleanup failure leaves new index readable', async () => {
    const old = makeSection('old', '# Old', 'old-hash', 'claude', 'old-manifest');
    const incoming = makeSection('new', '# New', 'new-hash', 'claude', 'new-manifest');
    const oldManifest = makeManifest('old-manifest', old);
    const incomingManifest = makeManifest('new-manifest', incoming);
    const store = makeStoreDeps({ [old.id]: old.hash }, [old], { [oldManifest.id]: oldManifest });
    const writeManifests = store.writeManifests;
    let manifestWrites = 0;
    store.writeManifests = async manifests => {
      manifestWrites++;
      if (manifestWrites === 2) throw new Error('cleanup failed');
      await writeManifests(manifests);
    };
    const deps = makeStubDeps({ store, compile: () => ({ store: new Map([[incoming.id, incoming]]), errors: [], manifests: [incomingManifest] }) });

    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.errors).toEqual(['stale manifest cleanup failed: cleanup failed']);
    expect(await store.readIndex()).toEqual({ [incoming.id]: incoming.hash });
    expect((await store.readSections([incoming.id])).get(incoming.id)).toEqual(incoming);
  });

  it('index lock acquisition times out before writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-index-lock-'));
    const store = new FileStore(dir);
    try {
      await store.writeIndex({ old: 'old-hash' });
      writeFileSync(join(dir, '.index.lock'), JSON.stringify({ token: 'live', pid: process.pid, createdAt: Date.now() }));
      const deps = makeStubDeps({ store });

      expect(JSON.parse(await handleIndexSkills(deps, 'claude')).errors).toEqual(['index: index lock timed out']);
      expect(await store.readIndex()).toEqual({ old: 'old-hash' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('concurrent different-system indexing preserves both updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-index-processes-'));
    const toolsUrl = pathToFileURL(resolve('dist/mcp/tools.js')).href;
    const storeUrl = pathToFileURL(resolve('dist/store/fileStore.js')).href;
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { FileStore } from ${JSON.stringify(storeUrl)};
      import { handleIndexSkills } from ${JSON.stringify(toolsUrl)};
      const dir = process.env.STORE_DIR;
      const system = process.env.SYSTEM;
      const other = system === 'claude' ? 'opencode' : 'claude';
      const store = new FileStore(dir);
      await store.init();
      const section = { id: system + '-section', title: system, content: '# ' + system, hash: system + '-hash', system };
      const deps = {
        discover: () => {
          writeFileSync(join(dir, 'ready-' + system), '');
          while (!existsSync(join(dir, 'ready-' + other))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          return { artifacts: [], errors: [] };
        },
        normalize: () => ({ inputs: [], errors: [] }),
        compile: () => ({ store: new Map([[section.id, section]]), errors: [] }),
        loadContext: () => ({ sections: [], context: '' }),
        store,
        resolveHomeDir: () => dir,
        resolveWorkspaceRoot: () => dir
      };
      const result = JSON.parse(await handleIndexSkills(deps, system));
      if (result.errors?.length) throw new Error(result.errors.join(', '));
    `;
    try {
      await Promise.all(['claude', 'opencode'].map(system => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STORE_DIR: dir, SYSTEM: system }, timeout: 10_000 })));
      expect(await new FileStore(dir).readIndex()).toEqual({ 'claude-section': 'claude-hash', 'opencode-section': 'opencode-hash' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists compile manifests during indexing', async () => {
    const section = makeSection('manifest-skill::overview', '# Hello', 'hash1', 'claude', 'manifest-skill');
    const manifest: SkillManifest = {
      id: 'manifest-skill',
      skillName: 'manifest-skill',
      system: 'claude',
      sourcePath: '/tmp/manifest-skill.md',
      sourceHash: 'srcHash',
      sections: [{
        id: 'manifest-skill::overview',
        title: 'Overview',
        class: 'always',
        tokenCount: 5,
        byteLength: 20,
        references: [],
        order: 0
      }],
      tokenCount: 5,
      byteLength: 20
    };
    const deps = makeStubDeps({
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('manifest-skill', section);
        return { store, errors: [], manifests: [manifest] };
      }
    });
    const result = await handleIndexSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.indexedSections).toBe(1);

    // Verify manifest was persisted
    const storedManifests = await deps.store.readManifests();
    expect(storedManifests['manifest-skill']).toEqual(manifest);
  });

  it('indexedSkills counts manifests not sections when manifets present', async () => {
    // Three sections across two manifests → indexedSkills=2, indexedSections=3
    const s1 = makeSection('m1::overview', '# Overview', 'h1', 'claude', 'm1');
    const s2 = makeSection('m1::setup', '# Setup', 'h2', 'claude', 'm1');
    const s3 = makeSection('m2::overview', '# Other', 'h3', 'claude', 'm2');
    const deps = makeStubDeps({
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('m1::overview', s1);
        store.set('m1::setup', s2);
        store.set('m2::overview', s3);
        return {
          store,
          errors: [],
          manifests: [{ id: 'm1', skillName: 'm1', system: 'claude', sourcePath: '', sourceHash: '', sections: [], tokenCount: 0, byteLength: 0 },
                      { id: 'm2', skillName: 'm2', system: 'claude', sourcePath: '', sourceHash: '', sections: [], tokenCount: 0, byteLength: 0 }]
        };
      }
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(2);
    expect(parsed.indexedSections).toBe(3);
  });

  it('only compiles artifacts for the requested system', async () => {
    let normalized: DiscoveredArtifact[] = [];
    const deps = makeStubDeps({
      discover: () => ({ artifacts: [makeArtifact('claude'), makeArtifact('opencode')], errors: [] }),
      normalize: (artifacts) => { normalized = artifacts; return { inputs: [], errors: [] }; }
    });
    await handleIndexSkills(deps, 'claude');
    expect(normalized.map(a => a.system)).toEqual(['claude']);
  });

  it('attributes explicit roots to the requested system', async () => {
    let seen: DiscoveryContext | undefined;
    let normalized: DiscoveredArtifact[] = [];
    const deps = makeStubDeps({
      discover: (ctx) => {
        seen = ctx;
        return { artifacts: [makeArtifact(ctx.explicitRootSystem!, '/plugin/root/skill.md')], errors: [] };
      },
      normalize: (artifacts) => { normalized = artifacts; return { inputs: [], errors: [] }; }
    });
    await handleIndexSkills(deps, 'claude', ['/plugin/root']);
    expect(seen!.explicitRoots).toEqual(['/plugin/root']);
    expect(seen!.explicitRootSystem).toBe('claude');
    expect(normalized.map(a => a.system)).toEqual(['claude']);
  });

  it('indexes a generic explicit root with generic manifest IDs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mcp-generic-'));
    const root = join(workspace, 'unknown', 'skills');
    mkdirSync(join(root, 'demo'), { recursive: true });
    writeFileSync(join(root, 'demo', 'SKILL.md'), '---\nname: demo\n---\n# Demo\n\nGeneric content.');
    try {
      const deps = makeStubDeps({
        discover,
        normalize,
        compile: (inputs, ctx) => {
          const result = compile(inputs, ctx);
          return { ...result, store: result.store instanceof Map ? result.store : new Map(Object.entries(result.store)) };
        },
        resolveWorkspaceRoot: () => workspace,
        resolveHomeDir: () => workspace
      });
      const parsed = JSON.parse(await handleIndexSkills(deps, 'generic', [root]));
      expect(parsed.indexedSkills).toBe(1);
      expect(Object.keys(await deps.store.readManifests())).toEqual([expect.stringMatching(/^generic::demo::/)]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  it('indexes ancestor instructions from a nested Git workspace', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'mcp-nested-repo-'));
    const workspace = join(repo, 'packages', 'app');
    const home = join(repo, 'home');
    const store = new FileStore(join(repo, 'store'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home);
    writeFileSync(join(repo, 'AGENTS.md'), '# Repository instructions\n\nUse the ancestor configuration.');
    await store.init();
    try {
      const deps = makeStubDeps({ discover, normalize, compile, store, resolveWorkspaceRoot: () => workspace, resolveHomeDir: () => home });
      const parsed = JSON.parse(await handleIndexSkills(deps, 'codex'));
      expect(parsed.errors).toEqual([]);
      expect(Object.values(await store.readManifests()).some(manifest => manifest.sourcePath === join(repo, 'AGENTS.md'))).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('preserves other systems when indexing without force', async () => {
    const opencode = makeSection('open', '# Open', 'hOpen', 'opencode');
    const claude = makeSection('claude', '# Claude', 'hClaude', 'claude');
    const deps = makeStubDeps({
      store: makeStoreDeps({ open: 'hOpen' }, [opencode]),
      discover: () => ({ artifacts: [makeArtifact('claude')], errors: [] }),
      normalize: () => ({ inputs: [{} as NormalizedSkillInput], errors: [] }),
      compile: () => ({ store: new Map([['claude', claude]]), errors: [] })
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(1);
    expect(await deps.store.readIndex()).toMatchObject({ open: 'hOpen', claude: 'hClaude' });
  });

  it('reindex same system prunes old manifests for that system', async () => {
    // First index: manifest for skill with hash aaa11111
    const oldM: SkillManifest = {
      id: 'claude::skill::aaa11111', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::skill::aaa11111::overview', title: 'Old', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };
    const oldSection = makeSection('claude::skill::aaa11111::overview', '# Old', 'oldHash', 'claude', 'claude::skill::aaa11111');
    const oldStore = makeStoreDeps(
      { 'claude::skill::aaa11111::overview': 'oldHash' },
      [oldSection],
      { 'claude::skill::aaa11111': oldM, 'opencode::other::ccc33333': { id: 'opencode::other::ccc33333', skillName: 'other', system: 'opencode', sourcePath: '/tmp/o.md', sourceHash: 'ccc333333333', sections: [], tokenCount: 0, byteLength: 0 } }
    );

    // Reindex claude: new manifest with different hash bbb22222 replaces old
    const newM: SkillManifest = {
      id: 'claude::skill::bbb22222', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill-v2.md', sourceHash: 'bbb222222222',
      sections: [{ id: 'claude::skill::bbb22222::overview', title: 'New', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };
    const newSection = makeSection('claude::skill::bbb22222::overview', '# New', 'newHash', 'claude', 'claude::skill::bbb22222');
    const deps = makeStubDeps({
      store: oldStore,
      discover: () => ({ artifacts: [makeArtifact('claude')], errors: [] }),
      normalize: () => ({ inputs: [{ system: 'claude', skillName: 'skill', sourceHash: 'bbb222222222' } as NormalizedSkillInput], errors: [] }),
      compile: () => ({
        store: new Map([['claude::skill::bbb22222::overview', newSection]]),
        errors: [],
        manifests: [newM]
      })
    });

    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(1);

    // New manifest stored
    const manifests = await deps.store.readManifests();
    expect(manifests['claude::skill::bbb22222']).toBeDefined();
    // Old manifest for same system pruned
    expect(manifests['claude::skill::aaa11111']).toBeUndefined();
    // Other system's manifest preserved
    expect(manifests['opencode::other::ccc33333']).toBeDefined();

    // get_skill_manifest on old ID returns not found
    const gotOld = JSON.parse(await handleGetSkillManifest(deps, 'claude::skill::aaa11111'));
    expect(gotOld.errors).toBeDefined();
    expect(gotOld.errors[0]).toContain('not found');

    // get_skill_manifest on new ID returns manifest
    const gotNew = JSON.parse(await handleGetSkillManifest(deps, 'claude::skill::bbb22222'));
    expect(gotNew.exists).toBe(true);
    expect(gotNew.sourceHash).toBe('bbb222222222');
  });

  it('reindex to zero manifests prunes stale persisted manifests', async () => {
    // ponytail: system had manifests, re-index produces none → manifests pruned
    const oldM: SkillManifest = {
      id: 'stale::skill::aaa11111', skillName: 'stale-skill', system: 'claude',
      sourcePath: '/tmp/stale.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'stale::skill::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };
    const otherM: SkillManifest = {
      id: 'opencode::other::bbb22222', skillName: 'other', system: 'opencode',
      sourcePath: '/tmp/other.md', sourceHash: 'bbb222222222',
      sections: [{ id: 'opencode::other::bbb22222::overview', title: 'Overview', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };
    const store = makeStoreDeps({}, [], { 'stale::skill::aaa11111': oldM, 'opencode::other::bbb22222': otherM });
    const deps = makeStubDeps({
      store,
      discover: () => ({ artifacts: [makeArtifact('claude')], errors: [] }),
      normalize: () => ({ inputs: [], errors: [] }),
      // compile returns no manifests (zero-manifest re-index)
      compile: () => ({ store: new Map(), errors: [] })
    });

    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(0);
    expect(parsed.indexedSections).toBe(0);

    // Stale claude manifest pruned
    const manifests = await deps.store.readManifests();
    expect(manifests['stale::skill::aaa11111']).toBeUndefined();
    // Other system's manifest preserved
    expect(manifests['opencode::other::bbb22222']).toBeDefined();

    // list_skills no longer exposes the stale manifest
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.skills).toEqual([]);
    expect(list.count).toBe(0);
  });

  it('returns conflictCount and diagnostics from compiler result', async () => {
    const section = makeSection('skill-a', '# A', 'hA');
    const diagnostics: SkillConflictDiagnostic[] = [{
      conflictKey: 'claude::skill-shared',
      winner: { system: 'claude', sourcePath: '/tmp/winner.md', sourceHash: 'abc' },
      shadowed: [{ system: 'opencode', sourcePath: '/tmp/loser.md', sourceHash: 'def' }],
      reason: 'higher_precedence',
      winnerPrecedence: 80
    }];
    const deps = makeStubDeps({
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('skill-a', section);
        return { store, errors: [], diagnostics };
      }
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.diagnostics).toBeDefined();
    expect(parsed.diagnostics[0].conflictKey).toBe('claude::skill-shared');
    expect(parsed.diagnostics[0].reason).toBe('higher_precedence');
  });

  it('diagnostics-only — indexing succeeds with conflict info', async () => {
    const section = makeSection('skill-a', '# A', 'hA');
    const diagnostics: SkillConflictDiagnostic[] = [{
      conflictKey: 'claude::skill-shared',
      winner: { system: 'claude', sourcePath: '/tmp/winner.md', sourceHash: 'abc' },
      shadowed: [{ system: 'opencode', sourcePath: '/tmp/loser.md', sourceHash: 'def' }],
      reason: 'higher_precedence',
      winnerPrecedence: 80
    }];
    const deps = makeStubDeps({
      compile: () => {
        const store = new Map<string, SkillSection>();
        store.set('skill-a', section);
        return { store, errors: [], diagnostics };
      }
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.diagnostics).toBeDefined();
    expect(parsed.errors).toEqual([]);
  });

  it('errors-only — bails with formatted errors', async () => {
    const deps = makeStubDeps({
      compile: () => ({ store: new Map(), errors: [{ path: '/tmp/parse.md', error: 'Failed to parse markdown' }] })
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors).toEqual(['/tmp/parse.md: Failed to parse markdown']);
    expect(parsed.indexedSkills).toBeUndefined();
  });

  it('diagnostics + unrelated error — bails on non-conflict error', async () => {
    const deps = makeStubDeps({
      compile: () => ({
        store: new Map(),
        errors: [{ path: '/tmp/broken.md', error: 'Failed to parse markdown' }],
        diagnostics: [{ conflictKey: 'k', winner: { system: 'claude', sourcePath: '/w.md', sourceHash: 'h' }, shadowed: [], reason: 'higher_precedence', winnerPrecedence: 80 }]
      })
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.errors).toEqual(['/tmp/broken.md: Failed to parse markdown']);
    expect(parsed.indexedSkills).toBeUndefined();
    expect(parsed.conflictCount).toBeUndefined();
  });

  it('diagnostics + legacy conflict error — conflict error is non-fatal', async () => {
    const section = makeSection('skill-a', '# A', 'hA');
    const diagnostics: SkillConflictDiagnostic[] = [{
      conflictKey: 'claude::shared',
      winner: { system: 'claude', sourcePath: '/w.md', sourceHash: 'h' },
      shadowed: [{ system: 'opencode', sourcePath: '/l.md', sourceHash: 'l' }],
      reason: 'higher_precedence',
      winnerPrecedence: 80
    }];
    const deps = makeStubDeps({
      compile: () => ({
        store: new Map([['skill-a', section]]),
        errors: [{ path: '/tmp/loser.md', error: 'Skill conflict: \'opencode::shared\' dropped (precedence 60 < 80); winner at /tmp/winner.md' }],
        diagnostics
      })
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSkills).toBe(1);
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.errors).toEqual([]);
    expect(parsed.diagnostics).toBeDefined();
  });

  it('omits conflictCount when no diagnostics', async () => {
    const deps = makeStubDeps({
      compile: () => ({ store: new Map(), errors: [] })
    });
    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.conflictCount).toBeUndefined();
    expect(parsed.diagnostics).toBeUndefined();
  });

  it('keeps nonfatal discovery diagnostics separate from compiler diagnostics', async () => {
    const section = makeSection('diagnosed', '# Diagnosed');
    const compilerDiagnostic: SkillConflictDiagnostic = {
      conflictKey: 'claude::diagnosed',
      winner: { system: 'claude', sourcePath: '/winner.md', sourceHash: 'winner' },
      shadowed: [], reason: 'same_precedence_tiebreak', winnerPrecedence: 80
    };
    const deps = makeStubDeps({
      discover: () => ({ artifacts: [], errors: [], discoveryDiagnostics: [discoveryDiagnostic] }),
      compile: () => ({ store: new Map([[section.id, section]]), errors: [], diagnostics: [compilerDiagnostic] })
    });

    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.indexedSections).toBe(1);
    expect(parsed.discoveryDiagnostics).toEqual([discoveryDiagnostic]);
    expect(parsed.diagnostics).toEqual([compilerDiagnostic]);
    expect(parsed.errors).toEqual([]);
  });

  it('does not persist discovery diagnostics', async () => {
    const persisted: unknown[] = [];
    const store = makeStoreDeps();
    const writeSections = store.writeSections;
    const writeManifests = store.writeManifests;
    const writeIndex = store.writeIndex;
    store.writeSections = async value => { persisted.push([...value.values()]); await writeSections(value); };
    store.writeManifests = async value => { persisted.push(value); await writeManifests(value); };
    store.writeIndex = async value => { persisted.push(value); await writeIndex(value); };
    const deps = makeStubDeps({
      store,
      discover: () => ({ artifacts: [], errors: [], discoveryDiagnostics: [discoveryDiagnostic] })
    });

    const parsed = JSON.parse(await handleIndexSkills(deps, 'claude'));
    expect(parsed.discoveryDiagnostics).toEqual([discoveryDiagnostic]);
    expect(JSON.stringify(persisted)).not.toContain('discoveryDiagnostics');
    expect(JSON.stringify(persisted)).not.toContain(discoveryDiagnostic.limitation);
  });

  it('invalid explicit root remains fatal before persistence', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'mcp-fatal-explicit-'));
    const store = makeStoreDeps();
    let writes = 0;
    store.writeSections = async () => { writes++; };
    store.writeManifests = async () => { writes++; };
    store.writeIndex = async () => { writes++; };
    const deps = makeStubDeps({
      store,
      discover,
      resolveWorkspaceRoot: () => workspace,
      resolveHomeDir: () => workspace
    });
    try {
      const missing = join(workspace, 'missing-explicit-root');
      const parsed = JSON.parse(await handleIndexSkills(deps, 'claude', [missing]));
      expect(parsed.errors[0]).toContain('explicit root does not exist');
      expect(parsed.indexedSkills).toBeUndefined();
      expect(writes).toBe(0);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});

describe('section retrieval freshness', () => {
  it('search_skill_sections requires rebuild without disclosing stale content', async () => {
    const section = makeSection('search-stale', 'cached search secret');
    writeFileSync(section.sourcePath!, 'changed same length!');
    const deps = makeStubDeps({ store: makeStoreDeps({ [section.id]: section.hash }, [section]) });

    const parsed = JSON.parse(await handleSearchSkillSections(deps, 'secret'));
    expect(parsed.rebuildRequired.code).toBe('REBUILD_REQUIRED');
    expect(parsed).not.toHaveProperty('sections');
    expect(JSON.stringify(parsed)).not.toContain(section.content);
  });

  it('resolve_task_sections requires rebuild without disclosing stale content', async () => {
    const section = makeSection('resolve-stale', 'cached resolve secret');
    writeFileSync(section.sourcePath!, 'changed same length!!');
    const deps = makeStubDeps({ store: makeStoreDeps({ [section.id]: section.hash }, [section]) });

    const parsed = JSON.parse(await handleResolveTaskSections(deps, 'secret'));
    expect(parsed.rebuildRequired.code).toBe('REBUILD_REQUIRED');
    expect(parsed).not.toHaveProperty('sections');
    expect(JSON.stringify(parsed)).not.toContain(section.content);
  });

  it('treats identical content with a changed timestamp as fresh', async () => {
    const section = makeSection('timestamp-fresh', '# unchanged');
    utimesSync(section.sourcePath!, new Date(), new Date(Date.now() + 10_000));
    const parsed = JSON.parse(await handleSearchSkillSections(makeStubDeps({ store: makeStoreDeps({ [section.id]: section.hash }, [section]) }), 'unchanged'));
    expect(parsed.freshness).toBeUndefined();
    expect(parsed.sections).toBeDefined();
  });

  it('detects same-size content changes even when mtime is restored', async () => {
    const section = makeSection('hash-stale', 'alpha');
    const original = statSync(section.sourcePath!);
    writeFileSync(section.sourcePath!, 'bravo');
    utimesSync(section.sourcePath!, original.atime, original.mtime);
    const parsed = JSON.parse(await handleSearchSkillSections(makeStubDeps({ store: makeStoreDeps({ [section.id]: section.hash }, [section]) }), 'alpha'));
    expect(parsed.freshness).toBe('stale');
    expect(parsed).not.toHaveProperty('sections');
  });
});

describe('handleListSkills', () => {
  it('returns empty when no skills indexed', async () => {
    const deps = makeStubDeps();
    const result = await handleListSkills(deps);
    const parsed = JSON.parse(result);
    expect(parsed.skills).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  it('lists all indexed skill IDs', async () => {
    const sections = [makeSection('a', '# A', 'hA'), makeSection('b', '# B', 'hB')];
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'a': 'hA', 'b': 'hB' }, sections)
    });
    const result = await handleListSkills(deps);
    const parsed = JSON.parse(result);
    expect(parsed.skills.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    expect(parsed.count).toBe(2);
    expect(parsed.skills.every((s: { skillName: string }) => s.skillName)).toBe(true);
  });

  it('filters by system metadata and excludes missing metadata', async () => {
    const claude = makeSection('a', '# A', 'hA', 'claude');
    const opencode = makeSection('b', '# B', 'hB', 'opencode');
    const legacy = { ...makeSection('legacy', '# Legacy', 'hLegacy'), system: undefined };
    const deps = makeStubDeps({
      store: makeStoreDeps({ a: 'hA', b: 'hB', legacy: 'hLegacy' }, [claude, opencode, legacy])
    });
    const result = await handleListSkills(deps, 'claude');
    const parsed = JSON.parse(result);
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['a']);
    expect(parsed.count).toBe(1);
    expect(JSON.parse(await handleListSkills(deps)).skills.map((s: { id: string }) => s.id)).toContain('legacy');
  });

  it('returns manifest/skill IDs (not section IDs) when sections have manifestId', async () => {
    // Two sections with same manifestId = one skill
    const s1 = makeSection('skill-a::overview', '# Overview', 'h1', 'claude', 'skill-a');
    const s2 = makeSection('skill-a::setup', '# Setup', 'h2', 'claude', 'skill-a');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-a::overview': 'h1', 'skill-a::setup': 'h2' }, [s1, s2])
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['skill-a']);
    expect(parsed.count).toBe(1);
  });

  it('deduplicates manifest IDs when multiple sections share the same skill', async () => {
    const s1 = makeSection('a::overview', '# Overview', 'h1', 'claude', 'shared');
    const s2 = makeSection('a::setup', '# Setup', 'h2', 'claude', 'shared');
    const s3 = makeSection('b::overview', '# B', 'h3', 'opencode', 'other');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'a::overview': 'h1', 'a::setup': 'h2', 'b::overview': 'h3' }, [s1, s2, s3])
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills.map((s: { id: string }) => s.id).sort()).toEqual(['other', 'shared']);
    expect(parsed.count).toBe(2);
  });

  it('filters stale manifests whose sections are not in the live index', async () => {
    // ponytail: manifest persisted but its sections no longer exist in index → hidden
    const liveManifest: SkillManifest = {
      id: 'live-skill', skillName: 'live-skill', system: 'claude',
      sourcePath: '/tmp/live.md', sourceHash: 'abc123',
      sections: [{ id: 'live-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const staleManifest: SkillManifest = {
      id: 'stale-skill', skillName: 'stale-skill', system: 'claude',
      sourcePath: '/tmp/stale.md', sourceHash: 'deadbeef',
      sections: [{ id: 'stale-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    // Only live-skill's section is in the index; stale-skill's section is missing
    const liveSection = makeSection('live-skill::overview', '# Live', 'h1', 'claude', 'live-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'live-skill::overview': 'h1' },
        [liveSection],
        { 'live-skill': liveManifest, 'stale-skill': staleManifest }
      )
    });

    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['live-skill']);
    expect(parsed.count).toBe(1);
  });

  it('returns fallback summary for legacy system when other systems have live manifests', async () => {
    // Live manifest for claude system
    const claudeManifest: SkillManifest = {
      id: 'claude-skill', skillName: 'claude-skill', system: 'claude',
      sourcePath: '/tmp/claude.md', sourceHash: 'abc123',
      sections: [{ id: 'claude-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const claudeSection = makeSection('claude-skill::overview', '# C', 'hC', 'claude', 'claude-skill');

    // Legacy opencode sections without persisted manifest
    const legacySection = makeSection('legacy-skill', '# Legacy', 'hL', 'opencode');

    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude-skill::overview': 'hC', 'legacy-skill': 'hL' },
        [claudeSection, legacySection],
        { 'claude-skill': claudeManifest }
      )
    });

    // list_skills(system='opencode') — only legacy sections, no manifests for opencode
    const parsed = JSON.parse(await handleListSkills(deps, 'opencode'));
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['legacy-skill']);
    expect(parsed.count).toBe(1);
  });

  it('hides fallback entries tied to stale persisted manifest (list/get consistency)', async () => {
    // Regression: persisted manifest has empty sections → not live (liveness
    // skips it). A live indexed section has manifestId=same but the persisted
    // manifest is stale/corrupt. list_skills must NOT return this skillId via
    // fallback because get_* would find the stale persisted manifest and reject
    // it — exposing the same skillId in list would be inconsistent.
    const staleManifest: SkillManifest = {
      id: 'stale-skill', skillName: 'stale-skill', system: 'claude',
      sourcePath: '/tmp/stale.md', sourceHash: 'deadbeef',
      sections: [], // empty → liveness check skips it entirely
      tokenCount: 0, byteLength: 0
    };
    const section = makeSection('some-section', '# Content', 'h1', 'claude', 'stale-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'some-section': 'h1' },
        [section],
        { 'stale-skill': staleManifest }
      )
    });

    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills.map((s: { id: string }) => s.id)).not.toContain('stale-skill');
    expect(parsed.count).toBe(0);

    // Confirm get_skill_manifest rejects it (proving consistency)
    const got = JSON.parse(await handleGetSkillManifest(deps, 'stale-skill'));
    expect(got.errors).toBeDefined();
    expect(got.errors[0]).toContain('not found');
  });

  it('hides corrupt manifest whose indexed section has mismatched manifestId', async () => {
    // Manifest for skill with hash aaa, but the stored section claims a different manifestId
    const corruptManifest: SkillManifest = {
      id: 'claude::skill::aaa11111', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::skill::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 }],
      tokenCount: 3, byteLength: 15
    };
    // Section exists in index but manifestId points to a DIFFERENT manifest (stale/corrupt)
    const mismatchedSection = makeSection(
      'claude::skill::aaa11111::overview', '# Overview', 'hs',
      'claude', 'claude::skill::DIFFERENT_HASH'
    );
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude::skill::aaa11111::overview': 'hs' },
        [mismatchedSection],
        { 'claude::skill::aaa11111': corruptManifest }
      )
    });

    // The corrupt manifest should be hidden; the section appears as legacy fallback
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills.map((s: { id: string }) => s.id)).toEqual(['claude::skill::DIFFERENT_HASH']);
    expect(parsed.count).toBe(1);
  });

  it('includes kind and null description from typed manifest', async () => {
    const manifest: SkillManifest = {
      id: 'skill-1', skillName: 'skill-1', system: 'claude',
      kind: 'instruction_file', description: null,
      sourcePath: '/tmp/skill.md', sourceHash: 'abc',
      sections: [{ id: 'skill-1::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const section = makeSection('skill-1::overview', '# Hello', 'h1', 'claude', 'skill-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1::overview': 'h1' }, [section], { 'skill-1': manifest })
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].kind).toBe('instruction_file');
    expect(parsed.skills[0].description).toBeNull();
  });

  it('includes kind and description from a real typed persisted manifest', async () => {
    const manifest: SkillManifest = {
      id: 'skill-1', skillName: 'skill-1', system: 'claude',
      kind: 'skill_package',
      description: 'A test skill',
      sourcePath: '/tmp/skill.md', sourceHash: 'abc',
      sections: [{ id: 'skill-1::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const section = makeSection('skill-1::overview', '# Hello', 'h1', 'claude', 'skill-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1::overview': 'h1' }, [section], { 'skill-1': manifest })
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].kind).toBe('skill_package');
    expect(parsed.skills[0].description).toBe('A test skill');
  });

  it('includes kind and description as null for fallback skills', async () => {
    const section = makeSection('legacy-skill', '# Leg', 'hL');
    const deps = makeStubDeps({ store: makeStoreDeps({ 'legacy-skill': 'hL' }, [section]) });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].kind).toBeNull();
    expect(parsed.skills[0].description).toBeNull();
  });

  it('includes system and tokenCount for fallback skills', async () => {
    const s1 = { ...makeSection('leg-a', '# A', 'h1', 'opencode'), tokenCount: 10 };
    const s2 = { ...makeSection('leg-b', '# B', 'h2', 'opencode'), tokenCount: 5 };
    // Third section with no tokenCount and different system — grouped under same fallback id via manifestId
    const s3 = { ...makeSection('leg-c', '# C', 'h3', 'opencode'), manifestId: 'leg-a' };
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'leg-a': 'h1', 'leg-b': 'h2', 'leg-c': 'h3' }, [s1, s2, s3])
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    // leg-a and leg-c share manifestId 'leg-a' → one fallback entry; leg-b is separate
    const legA = parsed.skills.find((s: { id: string }) => s.id === 'leg-a');
    expect(legA.system).toBe('opencode');
    expect(legA.tokenCount).toBe(10); // s1 has 10, s3 has undefined → 0
    const legB = parsed.skills.find((s: { id: string }) => s.id === 'leg-b');
    expect(legB.system).toBe('opencode');
    expect(legB.tokenCount).toBe(5);
  });

  it('fallback system is null when no section has a system', async () => {
    const section = { ...makeSection('no-sys', '# X', 'hX'), system: undefined, tokenCount: 3 };
    const deps = makeStubDeps({ store: makeStoreDeps({ 'no-sys': 'hX' }, [section]) });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].system).toBeNull();
    expect(parsed.skills[0].tokenCount).toBe(3);
  });

  it('returns bounded stale metadata without changed source content', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    writeFileSync(section.sourcePath!, '# Changed', 'utf-8');
    section.mtimeMs = 0;
    section.size = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleLoadSkillContext(deps));
    expect(parsed.freshness).toBe('stale');
    expect(parsed).not.toHaveProperty('content');
    expect(parsed.rebuildRequired).toBeDefined();
    expect(parsed.rebuildRequired.code).toBe('REBUILD_REQUIRED');
    expect(parsed.rebuildRequired.action).toBe('index_skills');
    expect(parsed.rebuildRequired.sectionIds).toEqual([section.id]);
    expect(parsed.rebuildRequired.manifestIds).toEqual(['skill-1']);
    expect(parsed.rebuildRequired.reason).toBe('source_changed');
  });

  it('defaults kind and description to null when persisted manifest lacks those fields', async () => {
    // Older persisted manifests on disk may not have kind/description keys
    const manifest = {
      id: 'old-manifest', skillName: 'old-manifest', system: 'claude' as const,
      sourcePath: '/tmp/old.md', sourceHash: 'abc',
      sections: [{ id: 'old-manifest::overview', title: 'Overview', class: 'always' as const, tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    } as SkillManifest; // cast — omits kind/description from the spread
    const section = makeSection('old-manifest::overview', '# Hello', 'h1', 'claude', 'old-manifest');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'old-manifest::overview': 'h1' }, [section], { 'old-manifest': manifest })
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].kind).toBeNull();
    expect(parsed.skills[0].description).toBeNull();
    // Keys must be present, not undefined
    expect(parsed.skills[0]).toHaveProperty('kind');
    expect(parsed.skills[0]).toHaveProperty('description');
  });

  it('has kind and description in all skill entries', async () => {
    const manifest: SkillManifest = {
      id: 'skill-a', skillName: 'skill-a', system: 'claude',
      kind: 'instruction_file', description: null,
      sourcePath: '/tmp/a.md', sourceHash: 'src', sections: [], tokenCount: 0, byteLength: 0
    };
    const section = makeSection('skill-a', '# Hello', 'h1', 'claude', 'skill-a');
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-a': 'h1' }, [section], { 'skill-a': manifest }) });
    const parsed = JSON.parse(await handleListSkills(deps));
    for (const skill of parsed.skills) {
      expect(skill).toHaveProperty('kind');
      expect(skill).toHaveProperty('description');
    }
  });

  it('includes precedence and conflictCount from manifest', async () => {
    const diagnostics: SkillConflictDiagnostic[] = [{
      conflictKey: 'claude::shared-name',
      winner: { system: 'claude', sourcePath: '/tmp/winner.md', sourceHash: 'abc' },
      shadowed: [{ system: 'opencode', sourcePath: '/tmp/loser.md', sourceHash: 'def' }],
      reason: 'higher_precedence',
      winnerPrecedence: 80
    }];
    const manifest: SkillManifest = {
      id: 'conflict-skill', skillName: 'conflict-skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'abc',
      sections: [{ id: 'conflict-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8,
      precedence: 80,
      conflicts: diagnostics
    };
    const section = makeSection('conflict-skill::overview', '# Hello', 'h1', 'claude', 'conflict-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'conflict-skill::overview': 'h1' }, [section], { 'conflict-skill': manifest })
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].precedence).toBe(80);
    expect(parsed.skills[0].conflictCount).toBe(1);
  });

  it('precedence is undefined and conflictCount is 0 when manifest has no conflict fields', async () => {
    const manifest: SkillManifest = {
      id: 'clean-skill', skillName: 'clean-skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'abc',
      sections: [{ id: 'clean-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const section = makeSection('clean-skill::overview', '# Hello', 'h1', 'claude', 'clean-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'clean-skill::overview': 'h1' }, [section], { 'clean-skill': manifest })
    });
    const parsed = JSON.parse(await handleListSkills(deps));
    expect(parsed.skills[0].precedence).toBeUndefined();
    expect(parsed.skills[0].conflictCount).toBe(0);
  });
});

describe('handleGetSkillManifest', () => {
  it('returns error for unknown skill', async () => {
    const deps = makeStubDeps();
    const result = await handleGetSkillManifest(deps, 'nonexistent');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
  });

  it('returns manifest for known skill from persisted manifest', async () => {
    const manifest: SkillManifest = {
      id: 'skill-1',
      skillName: 'skill-1',
      system: 'claude',
      kind: 'skill_package',
      description: 'A persisted skill',
      sourcePath: '/tmp/skill-1.md',
      sourceHash: 'abcdef123456',
      sections: [{
        id: 'skill-1::overview',
        title: 'Overview',
        class: 'always',
        tokenCount: 5,
        byteLength: 20,
        references: [],
        order: 0
      }],
      tokenCount: 5,
      byteLength: 20
    };
    const section = makeSection('skill-1::overview', '# Hello', 'h1', 'claude', 'skill-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1::overview': 'h1' }, [section], { 'skill-1': manifest })
    });
    const result = await handleGetSkillManifest(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.skillId).toBe('skill-1');
    expect(parsed.hash).toBe('abcdef123456');
    expect(parsed.exists).toBe(true);
    // Real manifest fields
    expect(parsed.id).toBe('skill-1');
    expect(parsed.skillName).toBe('skill-1');
    expect(parsed.kind).toBe('skill_package');
    expect(parsed.description).toBe('A persisted skill');
    expect(parsed.tokenCount).toBe(5);
    expect(parsed.byteLength).toBe(20);
    expect(parsed.sourceHash).toBe('abcdef123456');
    expect(parsed.sections).toHaveLength(1);
  });

  it('falls back to section reconstruction when manifest not persisted (backward compat)', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleGetSkillManifest(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.skillId).toBe('skill-1');
    expect(parsed.hash).toBe('h1');
    expect(parsed.exists).toBe(true);
  });

  it('get_skill_manifest rejects section ID as skill ID', async () => {
    // Section id 'sec-1::overview' is not a manifest ID — should be rejected
    const section = makeSection('sec-1::overview', '# Overview', 'h1', 'claude', 'sec-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'sec-1::overview': 'h1' }, [section])
    });
    const result = await handleGetSkillManifest(deps, 'sec-1::overview');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found');
  });

  it('returns all sections by manifestId without stored manifest (backward compat)', async () => {
    const s1 = makeSection('my-skill::overview', '# Overview', 'h1', 'claude', 'my-skill');
    const s2 = makeSection('my-skill::setup', '# Setup', 'h2', 'claude', 'my-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'my-skill::overview': 'h1', 'my-skill::setup': 'h2' }, [s1, s2])
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'my-skill'));
    expect(parsed.skillId).toBe('my-skill');
    expect(parsed.exists).toBe(true);
    expect(parsed.hash).toBe('h1'); // first section hash fallback in backward-compat
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections.map((s: { id: string }) => s.id).sort()).toEqual(['my-skill::overview', 'my-skill::setup']);
  });

  it('returns all sections when called with manifestId (compiled multi-section skill)', async () => {
    const manifest: SkillManifest = {
      id: 'my-skill',
      skillName: 'my-skill',
      system: 'claude',
      kind: 'skill_package',
      description: null,
      sourcePath: '/tmp/my-skill.md',
      sourceHash: 'src123',
      sections: [
        { id: 'my-skill::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 },
        { id: 'my-skill::setup', title: 'Setup', class: 'phase', tokenCount: 3, byteLength: 12, references: [], order: 1 }
      ],
      tokenCount: 6,
      byteLength: 27
    };
    const s1 = makeSection('my-skill::overview', '# Overview', 'h1', 'claude', 'my-skill');
    const s2 = makeSection('my-skill::setup', '# Setup', 'h2', 'claude', 'my-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'my-skill::overview': 'h1', 'my-skill::setup': 'h2' }, [s1, s2], { 'my-skill': manifest })
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'my-skill'));
    expect(parsed.skillId).toBe('my-skill');
    expect(parsed.exists).toBe(true);
    expect(parsed.hash).toBe('src123'); // manifest sourceHash when not in index
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections.map((s: { id: string }) => s.id).sort()).toEqual(['my-skill::overview', 'my-skill::setup']);
  });

  it('same skillName different system/sourceHash persist as distinct manifests and list separately', async () => {
    // ponytail: compound manifest IDs prevent collisions across systems
    const mClaude: SkillManifest = {
      id: 'claude::shared-name::aaa11111',
      skillName: 'shared-name',
      system: 'claude',
      sourcePath: '/tmp/claude-shared.md',
      sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::shared-name::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 }],
      tokenCount: 3, byteLength: 15
    };
    const mOpen: SkillManifest = {
      id: 'opencode::shared-name::bbb22222',
      skillName: 'shared-name',
      system: 'opencode',
      sourcePath: '/tmp/open-shared.md',
      sourceHash: 'bbb222222222',
      sections: [{ id: 'opencode::shared-name::bbb22222::overview', title: 'Overview', class: 'always', tokenCount: 4, byteLength: 18, references: [], order: 0 }],
      tokenCount: 4, byteLength: 18
    };
    const sClaude = makeSection('claude::shared-name::aaa11111::overview', '# Overview', 'hc', 'claude', 'claude::shared-name::aaa11111');
    const sOpen = makeSection('opencode::shared-name::bbb22222::overview', '# Overview', 'ho', 'opencode', 'opencode::shared-name::bbb22222');
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude::shared-name::aaa11111::overview': 'hc', 'opencode::shared-name::bbb22222::overview': 'ho' },
        [sClaude, sOpen],
        { 'claude::shared-name::aaa11111': mClaude, 'opencode::shared-name::bbb22222': mOpen }
      )
    });

    // List: two distinct skills
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.skills.map((s: { id: string }) => s.id).sort()).toEqual(['claude::shared-name::aaa11111', 'opencode::shared-name::bbb22222']);
    expect(list.count).toBe(2);

    // Get each manifest by its compound id
    const gotClaude = JSON.parse(await handleGetSkillManifest(deps, 'claude::shared-name::aaa11111'));
    expect(gotClaude.exists).toBe(true);
    expect(gotClaude.system).toBe('claude');
    expect(gotClaude.skillName).toBe('shared-name');

    const gotOpen = JSON.parse(await handleGetSkillManifest(deps, 'opencode::shared-name::bbb22222'));
    expect(gotOpen.exists).toBe(true);
    expect(gotOpen.system).toBe('opencode');
    expect(gotOpen.skillName).toBe('shared-name');
  });

  it('legacy no-manifest section listed by list_skills can be loaded by get_skill_manifest', async () => {
    // Section with no manifestId — fallback uses s.id as skill ID
    const section = makeSection('legacy-skill', '# Legacy', 'hL');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'legacy-skill': 'hL' }, [section])
    });
    // list_skills returns it
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.skills.map((s: { id: string }) => s.id)).toEqual(['legacy-skill']);
    // get_skill_manifest can load it via the fallback path
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'legacy-skill'));
    expect(parsed.skillId).toBe('legacy-skill');
    expect(parsed.exists).toBe(true);
    expect(parsed.hash).toBe('hL');
  });

  it('get_skill_manifest does not return stored manifest as exists true when no matching indexed sections', async () => {
    // Manifest persisted but no indexed sections match it → orphaned
    const manifest: SkillManifest = {
      id: 'orphan-manifest',
      skillName: 'orphan',
      system: 'claude',
      sourcePath: '/tmp/orphan.md',
      sourceHash: 'deadbeef',
      sections: [{ id: 'orphan::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    // Index has unrelated sections only, nothing matching this manifest
    const unrelated = makeSection('other-skill', '# Other', 'hO', 'opencode');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'other-skill': 'hO' }, [unrelated], { 'orphan-manifest': manifest })
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'orphan-manifest'));
    // Should report not found since no indexed sections match the manifest
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found');
  });

  it('liveness check requires section.manifestId === manifest.id (not skillName fallback)', async () => {
    // Manifest exists with id `claude::skill::aaa11111`
    const manifest: SkillManifest = {
      id: 'claude::skill::aaa11111', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::skill::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 }],
      tokenCount: 3, byteLength: 15
    };
    // Section exists with same manifestId prefix but belongs to a different manifest
    const staleSection = makeSection('claude::skill::aaa11111::overview', '# Overview', 'hs', 'claude', 'claude::skill::DIFFERENT_HASH');
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude::skill::aaa11111::overview': 'hs' },
        [staleSection],
        { 'claude::skill::aaa11111': manifest }
      )
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'claude::skill::aaa11111'));
    // Section ID starts with manifest.id but section.manifestId !== manifest.id → not live
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found');
  });

  it('exact manifest section IDs avoid prefix collision', async () => {
    // Manifest "skill" with section "skill::overview"
    // Manifest "skill-2" with section "skill-2::overview"
    // Prefix scan would match "skill-2::overview" for manifest "skill"
    const m1: SkillManifest = {
      id: 'skill', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'aaa00000',
      sections: [{ id: 'skill::overview', title: 'SkillOverview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const m2: SkillManifest = {
      id: 'skill-2', skillName: 'skill-2', system: 'claude',
      sourcePath: '/tmp/skill-2.md', sourceHash: 'bbb11111',
      sections: [{ id: 'skill-2::overview', title: 'Skill2Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2, byteLength: 8
    };
    const s1 = makeSection('skill::overview', '# Skill', 'hs', 'claude', 'skill');
    const s2 = makeSection('skill-2::overview', '# Skill2', 'hs2', 'claude', 'skill-2');
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'skill::overview': 'hs', 'skill-2::overview': 'hs2' },
        [s1, s2],
        { 'skill': m1, 'skill-2': m2 }
      )
    });

    // Get manifest for "skill" — must NOT return sections from "skill-2"
    const got = JSON.parse(await handleGetSkillManifest(deps, 'skill'));
    expect(got.exists).toBe(true);
    expect(got.sections).toHaveLength(1);
    expect(got.sections[0].id).toBe('skill::overview');

    // Get sections for "skill" — must NOT return sections from "skill-2"
    const gotSections = JSON.parse(await handleGetSkillSections(deps, 'skill'));
    expect(gotSections.sections).toHaveLength(1);
    expect(gotSections.sections[0].id).toBe('skill::overview');
  });

  it('two same skillName across systems get distinct sections and both remain in store', async () => {
    // Same skillName 'shared' from two systems — both should persist with distinct section IDs
    const sClaude = makeSection('claude::shared::aaa11111::overview', '# C', 'hc', 'claude', 'claude::shared::aaa11111');
    const sOpen = makeSection('opencode::shared::bbb22222::overview', '# O', 'ho', 'opencode', 'opencode::shared::bbb22222');
    const mClaude: SkillManifest = {
      id: 'claude::shared::aaa11111', skillName: 'shared', system: 'claude',
      sourcePath: '/tmp/c.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::shared::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };
    const mOpen: SkillManifest = {
      id: 'opencode::shared::bbb22222', skillName: 'shared', system: 'opencode',
      sourcePath: '/tmp/o.md', sourceHash: 'bbb222222222',
      sections: [{ id: 'opencode::shared::bbb22222::overview', title: 'Overview', class: 'always', tokenCount: 1, byteLength: 4, references: [], order: 0 }],
      tokenCount: 1, byteLength: 4
    };

    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude::shared::aaa11111::overview': 'hc', 'opencode::shared::bbb22222::overview': 'ho' },
        [sClaude, sOpen],
        { 'claude::shared::aaa11111': mClaude, 'opencode::shared::bbb22222': mOpen }
      )
    });

    // Both sections in store
    const idx = await deps.store.readIndex();
    expect(Object.keys(idx).sort()).toEqual([
      'claude::shared::aaa11111::overview',
      'opencode::shared::bbb22222::overview'
    ]);

    // Both manifests return exists: true independently
    const c = JSON.parse(await handleGetSkillManifest(deps, 'claude::shared::aaa11111'));
    expect(c.exists).toBe(true);
    expect(c.system).toBe('claude');

    const o = JSON.parse(await handleGetSkillManifest(deps, 'opencode::shared::bbb22222'));
    expect(o.exists).toBe(true);
    expect(o.system).toBe('opencode');

    // List returns both distinct skills
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.skills.map((s: { id: string }) => s.id).sort()).toEqual(['claude::shared::aaa11111', 'opencode::shared::bbb22222']);
    expect(list.count).toBe(2);
  });

  it('returns precedence and conflicts from persisted manifest', async () => {
    const diagnostics: SkillConflictDiagnostic[] = [{
      conflictKey: 'claude::shared',
      winner: { system: 'claude', sourcePath: '/tmp/winner.md', sourceHash: 'abc' },
      shadowed: [{ system: 'opencode', sourcePath: '/tmp/loser.md', sourceHash: 'def' }],
      reason: 'higher_precedence',
      winnerPrecedence: 80
    }];
    const manifest: SkillManifest = {
      id: 'conflict-skill',
      skillName: 'conflict-skill',
      system: 'claude',
      sourcePath: '/tmp/skill.md',
      sourceHash: 'abcdef',
      sections: [{ id: 'conflict-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2,
      byteLength: 8,
      precedence: 80,
      conflicts: diagnostics
    };
    const section = makeSection('conflict-skill::overview', '# Hello', 'h1', 'claude', 'conflict-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'conflict-skill::overview': 'h1' }, [section], { 'conflict-skill': manifest })
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'conflict-skill'));
    expect(parsed.exists).toBe(true);
    expect(parsed.precedence).toBe(80);
    expect(parsed.conflicts).toBeDefined();
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0].conflictKey).toBe('claude::shared');
    expect(parsed.conflicts[0].reason).toBe('higher_precedence');
    expect(parsed.conflicts[0].winnerPrecedence).toBe(80);
    expect(parsed.conflicts[0].shadowed).toHaveLength(1);
  });

  it('precedence is undefined and conflicts is undefined when manifest lacks them', async () => {
    const manifest: SkillManifest = {
      id: 'clean-skill',
      skillName: 'clean-skill',
      system: 'claude',
      sourcePath: '/tmp/skill.md',
      sourceHash: 'abcdef',
      sections: [{ id: 'clean-skill::overview', title: 'Overview', class: 'always', tokenCount: 2, byteLength: 8, references: [], order: 0 }],
      tokenCount: 2,
      byteLength: 8
    };
    const section = makeSection('clean-skill::overview', '# Hello', 'h1', 'claude', 'clean-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'clean-skill::overview': 'h1' }, [section], { 'clean-skill': manifest })
    });
    const parsed = JSON.parse(await handleGetSkillManifest(deps, 'clean-skill'));
    expect(parsed.exists).toBe(true);
    expect(parsed.precedence).toBeUndefined();
    expect(parsed.conflicts).toBeUndefined();
  });
});

describe('handleGetSkillSections', () => {
  it('returns error for unknown skill', async () => {
    const deps = makeStubDeps();
    const result = await handleGetSkillSections(deps, 'nonexistent');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
  });

  it('returns sections for known skill', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleGetSkillSections(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('returns stale load_section metadata without changed source content', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    writeFileSync(section.sourcePath!, '# Changed', 'utf-8');
    section.mtimeMs = 0;
    section.size = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleLoadSection(deps, 'skill-1'));
    expect(parsed.freshness).toBe('stale');
    expect(parsed).not.toHaveProperty('content');
    expect(parsed.rebuildRequired).toBeDefined();
    expect(parsed.rebuildRequired.code).toBe('REBUILD_REQUIRED');
    expect(parsed.rebuildRequired.action).toBe('index_skills');
    expect(parsed.rebuildRequired.sectionIds).toEqual([section.id]);
    expect(parsed.rebuildRequired.reason).toBe('source_changed');
  });

  it('does not require a rebuild when only source metadata changes', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    section.mtimeMs = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleGetSkillSections(deps, 'skill-1'));
    expect(parsed.rebuildRequired).toBeUndefined();
    expect(parsed.sections).toBeDefined();
  });

  it('returns sections matching by manifestId when skillId is not a section ID', async () => {
    const s1 = makeSection('my-skill::overview', '# Overview', 'h1', 'claude', 'my-skill');
    const s2 = makeSection('my-skill::setup', '# Setup', 'h2', 'claude', 'my-skill');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'my-skill::overview': 'h1', 'my-skill::setup': 'h2' }, [s1, s2])
    });
    // Pass manifest ID – not a section ID key in the index
    const parsed = JSON.parse(await handleGetSkillSections(deps, 'my-skill'));
    expect(parsed.errors).toBeUndefined();
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections.map((s: SkillSection) => s.id).sort()).toEqual(['my-skill::overview', 'my-skill::setup']);
  });

  it('get_skill_sections rejects section ID as skill ID', async () => {
    // Section id 'sec-2::detail' is not a manifest/skill ID — should be rejected
    const section = makeSection('sec-2::detail', '# Detail', 'h1', 'claude', 'sec-2');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'sec-2::detail': 'h1' }, [section])
    });
    const parsed = JSON.parse(await handleGetSkillSections(deps, 'sec-2::detail'));
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found');
  });

  it('returns not-found when persisted manifest section IDs exist in index but loaded sections have mismatched manifestId', async () => {
    // Corrupt/stale persisted manifest: section IDs in index, but loaded section
    // manifestId differs from the persisted manifest id. Should return error,
    // not { skillId, sections: [] } (empty success).
    const staleManifest: SkillManifest = {
      id: 'claude::skill::aaa11111', skillName: 'skill', system: 'claude',
      sourcePath: '/tmp/skill.md', sourceHash: 'aaa111111111',
      sections: [{ id: 'claude::skill::aaa11111::overview', title: 'Overview', class: 'always', tokenCount: 3, byteLength: 15, references: [], order: 0 }],
      tokenCount: 3, byteLength: 15
    };
    // Section exists in index but manifestId points to a DIFFERENT manifest
    const mismatchedSection = makeSection(
      'claude::skill::aaa11111::overview', '# Overview', 'hs',
      'claude', 'claude::skill::DIFFERENT_HASH'
    );
    const deps = makeStubDeps({
      store: makeStoreDeps(
        { 'claude::skill::aaa11111::overview': 'hs' },
        [mismatchedSection],
        { 'claude::skill::aaa11111': staleManifest }
      )
    });

    const parsed = JSON.parse(await handleGetSkillSections(deps, 'claude::skill::aaa11111'));
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found');
    // Must NOT return empty success
    expect(parsed.sections).toBeUndefined();
  });

  it('legacy no-manifest section listed by list_skills can be loaded by get_skill_sections', async () => {
    const section = makeSection('legacy-skill', '# Legacy', 'hL');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'legacy-skill': 'hL' }, [section])
    });
    // list_skills returns it
    const list = JSON.parse(await handleListSkills(deps));
    expect(list.skills.map((s: { id: string }) => s.id)).toEqual(['legacy-skill']);
    // get_skill_sections can load it via the fallback path
    const parsed = JSON.parse(await handleGetSkillSections(deps, 'legacy-skill'));
    expect(parsed.errors).toBeUndefined();
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].id).toBe('legacy-skill');
  });
});

describe('handleLoadSkillContext', () => {
  it('returns error when no skills indexed', async () => {
    const deps = makeStubDeps();
    const result = await handleLoadSkillContext(deps, 'some query');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
  });

  it('validates RetrievalBundle fields', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section]),
      loadContext: () => ({
        sections: [section],
        context: '# Hello'
      })
    });
    const result = await handleLoadSkillContext(deps, 'test');
    const parsed = JSON.parse(result);
    expect(parsed.sectionCount).toBe(1);
    expect(parsed.content).toBe('# Hello');
  });

  it('reports invalid bundle', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1');
    // ponytail: construct an invalid bundle to test runtime validation without any-typed casts
    function makeBadBundle(): RetrievalBundle {
      const bad = { sections: null, context: null };
      return bad as unknown as RetrievalBundle;
    }
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section]),
      loadContext: () => makeBadBundle()
    });
    const result = await handleLoadSkillContext(deps, 'test');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
  });

  it('catches loadContext throws', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section]),
      loadContext: () => { throw new Error('load failed'); }
    });
    const result = await handleLoadSkillContext(deps, 'test');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('load failed');
  });

  it('uses wired retrieval without stub error', async () => {
    const section = makeSection('skill-1', 'hello searchable', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section]),
      loadContext: (store) => ({ sections: Object.values(store as Record<string, SkillSection>), context: 'real retrieval' })
    });
    const parsed = JSON.parse(await handleLoadSkillContext(deps, 'hello'));
    expect(parsed.content).toBe('real retrieval');
  });

  it('passes phase, includeReferences, maxBytes through to loadContext', async () => {
    let received: any;
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [makeSection('skill-1', 'content', 'h1')]),
      loadContext: (_store, req) => { received = req; return { sections: [], context: 'ok' }; }
    });
    await handleLoadSkillContext(deps, 'search', 'build', true, 5000);
    // Should receive a RetrievalRequest object when progressive params are present
    expect(typeof received).not.toBe('string');
    expect(received.query).toBe('search');
    expect(received.phase).toBe('build');
    expect(received.includeReferences).toBe(true);
    expect(received.maxBytes).toBe(5000);
  });

  it('passes plain string to loadContext when no progressive params', async () => {
    let received: any;
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [makeSection('skill-1', 'content', 'h1')]),
      loadContext: (_store, req) => { received = req; return { sections: [], context: 'ok' }; }
    });
    await handleLoadSkillContext(deps, 'query only');
    // Should be a plain string for backwards compat
    expect(typeof received).toBe('string');
    expect(received).toBe('query only');
  });

  it('passes RetrievalRequest with only phase set (empty query)', async () => {
    let received: any;
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [makeSection('skill-1', 'content', 'h1')]),
      loadContext: (_store, req) => { received = req; return { sections: [], context: 'phase-only' }; }
    });
    await handleLoadSkillContext(deps, undefined, 'build');
    expect(typeof received).not.toBe('string');
    expect(received.phase).toBe('build');
    expect(received.query).toBeUndefined();
    expect(received.includeReferences).toBeUndefined();
    expect(received.maxBytes).toBeUndefined();
  });

  it('load_skill_context accepts empty request mode (no args)', async () => {
    let received: any;
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [makeSection('skill-1', 'content', 'h1')]),
      loadContext: (_store, req) => { received = req; return { sections: [], context: 'empty-request' }; }
    });
    await handleLoadSkillContext(deps);
    // Should receive empty object in request mode
    expect(typeof received).not.toBe('string');
    expect(received.query).toBeUndefined();
    expect(received.phase).toBeUndefined();
    expect(received.includeReferences).toBeUndefined();
    expect(received.maxBytes).toBeUndefined();
  });
});

describe('handleLoadSection', () => {
  it('returns error for unknown section', async () => {
    const deps = makeStubDeps();
    const result = await handleLoadSection(deps, 'nonexistent');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
  });

  it('detects duplicate references', async () => {
    const section = makeSection('skill-1', '# Hello\nSee [[ref-a]] and also [[ref-a]]', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleLoadSection(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.duplicateRefs).toBeDefined();
    expect(parsed.duplicateRefs!.length).toBeGreaterThan(0);
  });

  it('extracts markdown link targets', async () => {
    const section = makeSection('skill-1', '[ref-a](section-a) and [ref-b](section-b)', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleLoadSection(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.references).toContain('section-a');
    expect(parsed.references).toContain('section-b');
  });

  it('handles markdown link with title correctly', async () => {
    // `[local](./file.md "title")` should extract ./file.md, not ./file.md  "title"
    const section = makeSection('skill-1', '[local](./file.md "title") and [other](other.md)', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleLoadSection(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.references).toContain('./file.md');
    expect(parsed.references).toContain('other.md');
    expect(parsed.references).not.toContain('./file.md "title"');
  });

  it('handles markdown links with spaces in URL (GitHub-style)', async () => {
    // ponytail: extractMarkdownLinks regex excludes spaces from URL, but [[ref]] with spaces still works
    const section = makeSection('skill-1', '[[ref with spaces]]', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleLoadSection(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.references).toContain('ref with spaces');
  });

  it('returns no duplicateRefs when all unique', async () => {
    const section = makeSection('skill-1', '[[a]] [[b]] [[c]]', 'h1');
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'skill-1': 'h1' }, [section])
    });
    const result = await handleLoadSection(deps, 'skill-1');
    const parsed = JSON.parse(result);
    expect(parsed.duplicateRefs).toBeUndefined();
  });

  it('rejects orphan section file not present in live index', async () => {
    // Section file exists on disk but index has no entry for it (orphaned after re-index)
    const orphan = makeSection('orphan-section', '# Orphan', 'hOrphan');
    const deps = makeStubDeps({
      store: makeStoreDeps({}, [orphan]) // empty index, section in readSections
    });
    const result = await handleLoadSection(deps, 'orphan-section');
    const parsed = JSON.parse(result);
    expect(parsed.errors).toBeDefined();
    expect(parsed.errors[0]).toContain('not found in index');
  });
});
