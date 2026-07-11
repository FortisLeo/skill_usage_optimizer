// ponytail: MCP tool handler unit tests with stub deps
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiscoveredArtifact, DiscoveryContext, NormalizedSkillInput, BoundaryError, DiscoverResult, NormalizeResult, RetrievalBundle, SkillConflictDiagnostic, SkillManifest } from '../src/types.js';
import type { SkillSection, SkillStore } from '../src/store/fileStore.js';
import { computeHash } from '../src/fs/freshness.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import {
  handleIndexSkills,
  handleListSkills,
  handleGetSkillManifest,
  handleGetSkillSections,
  handleLoadSkillContext,
  handleLoadSection
} from '../src/mcp/tools.js';

const tempFiles = mkdtempSync(join(tmpdir(), 'mcp-tools-'));
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

  it('clears store on force', async () => {
    const deps = makeStubDeps({
      store: makeStoreDeps({ 'old': 'zzz' }, [makeSection('old', '# Old')])
    });
    await handleIndexSkills(deps, 'claude', undefined, undefined, true);
    const idx = await deps.store.readIndex();
    expect(idx['old']).toBeUndefined();
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

  it('returns stale load_skill_context fallback content with structured rebuildRequired', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    writeFileSync(section.sourcePath!, '# Changed', 'utf-8');
    section.mtimeMs = 0;
    section.size = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleLoadSkillContext(deps));
    expect(parsed.freshness).toBe('stale');
    expect(parsed.content).toBe('# Changed');
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

  it('returns stale load_section fallback content with structured rebuildRequired', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    writeFileSync(section.sourcePath!, '# Changed', 'utf-8');
    section.mtimeMs = 0;
    section.size = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleLoadSection(deps, 'skill-1'));
    expect(parsed.freshness).toBe('stale');
    expect(parsed.content).toBe('# Changed');
    expect(parsed.rebuildRequired).toBeDefined();
    expect(parsed.rebuildRequired.code).toBe('REBUILD_REQUIRED');
    expect(parsed.rebuildRequired.action).toBe('index_skills');
    expect(parsed.rebuildRequired.sectionIds).toEqual([section.id]);
    expect(parsed.rebuildRequired.reason).toBe('source_changed');
  });

  it('accepts changed mtime when content hash is unchanged', async () => {
    const section = makeSection('skill-1', '# Hello', 'h1', 'claude', 'skill-1');
    section.mtimeMs = 0;
    const deps = makeStubDeps({ store: makeStoreDeps({ 'skill-1': 'h1' }, [section]) });
    const parsed = JSON.parse(await handleGetSkillSections(deps, 'skill-1'));
    expect(parsed.sections[0].id).toBe('skill-1');
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
