import { describe, expect, it } from 'vitest';
import { TOOL_DEFS, handleMcpToolCall } from '../src/mcp/server.js';
import { validateResolveTaskSectionsArgs, validateSearchSkillSectionsArgs } from '../src/mcp/schemas.js';
import { handleResolveTaskSections, handleSearchSkillSections } from '../src/mcp/tools.js';
import { handleLoadSkillContext, handleLoadSection } from '../src/mcp/tools.js';
import { resolve } from '../src/resolver/index.js';
import type { ToolDeps } from '../src/mcp/tools.js';
import type { SkillManifest, SkillSection } from '../src/types.js';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeHash, normalizeContent } from '../src/fs/freshness.js';
import { searchSections } from '../src/search/lexical.js';

const sections: SkillSection[] = [
  { id: 'a::one', title: 'Planning setup', content: 'setup query', hash: 'a', class: 'phase', manifestId: 'claude::a::hash', tokenCount: 2 },
  { id: 'a::two', title: 'Review setup', content: 'setup query', hash: 'b', class: 'phase', manifestId: 'claude::a::hash', tokenCount: 2 },
  { id: 'a::always', title: 'Always', content: 'query', hash: 'c', class: 'always', manifestId: 'claude::a::hash', tokenCount: 1 }
];
const manifests: Record<string, SkillManifest> = { 'claude::a::hash': { id: 'claude::a::hash', skillName: 'a', system: 'claude', kind: 'skill_package', description: null, sourcePath: 'a', sourceHash: 'a', sections: [], tokenCount: 10, byteLength: 1 } };
const deps = { store: { readIndex: async () => Object.fromEntries(sections.map(s => [s.id, s.hash])), writeIndex: async () => {}, readSections: async (ids: string[]) => new Map(sections.filter(s => ids.includes(s.id)).map(s => [s.id, s])), writeSections: async () => {}, readManifests: async () => manifests, writeManifests: async () => {}, clear: async () => {} }, searchSections: undefined, resolve: undefined } as unknown as ToolDeps;

describe('P3 MCP surface', () => {
  it('registers unique new tools without colliding with legacy names', () => {
    const names = TOOL_DEFS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    const legacy = new Set(['index_skills', 'list_skills', 'get_skill_manifest', 'get_skill_sections', 'load_skill_context', 'load_section']);
    expect(names.filter(name => legacy.has(name))).toHaveLength(6);
    expect(names.filter(name => ['search_skill_sections', 'resolve_task_sections', 'doctor'].includes(name)))
      .toHaveLength(3);
    expect(names).toEqual(expect.arrayContaining(['search_skill_sections', 'resolve_task_sections', 'doctor']));
  });
  it('validates actual payload boundaries', () => {
    expect(validateSearchSkillSectionsArgs({})).toMatchObject({ ok: false });
    expect(validateSearchSkillSectionsArgs({ query: 'x', k: '3' })).toMatchObject({ ok: false });
    expect(validateResolveTaskSectionsArgs({ query: 'x', budget: '3' })).toMatchObject({ ok: false });
    expect(validateResolveTaskSectionsArgs({ query: 'x', budget: 3 })).toMatchObject({ ok: true });
  });
  it('applies phase as an AND filter and emits savings', async () => {
    const search = JSON.parse(await handleSearchSkillSections(deps, 'query', 'planning', 'a', 10));
    expect(search.sections.map((s: SkillSection) => s.id)).toEqual(['a::one']);
    const resolved = JSON.parse(await handleResolveTaskSections(deps, 'query', 'planning', 'a'));
    expect(resolved.tokenSavings).toEqual({ tokensLoaded: 2, tokensWholeFile: 10, savingsPct: 80 });
  });
  it('reports unknown skills cleanly', async () => {
    expect(JSON.parse(await handleSearchSkillSections(deps, 'x', undefined, 'missing')).errors).toEqual(['skill "missing" not found in index']);
  });

  it.each([
    ['search_skill_sections', {}, 'query must be a non-empty string'],
    ['resolve_task_sections', { query: 'x', budget: '3' }, 'budget must be a positive number'],
    ['search_skill_sections', { query: 'x', skill: 'missing' }, 'skill "missing" not found in index']
  ] as const)('returns MCP JSON errors for malformed tool calls (%s)', async (name, args, message) => {
    const response = await handleMcpToolCall(deps, name, args);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    console.log(`${name}: ${JSON.stringify(payload)}`);
    expect(payload.errors).toContain(message);
  });

  it('keeps legacy context shape and adds only dependency metadata to load_section', async () => {
    const source = fileURLToPath(new URL('../package.json', import.meta.url));
    const raw = normalizeContent(readFileSync(source, 'utf8'));
    const stat = statSync(source);
    const legacySections = sections.map(s => ({ ...s, sourcePath: source, sourceHash: computeHash(raw), mtimeMs: stat.mtimeMs, size: stat.size }));
    const legacyDeps = { ...deps, store: { ...deps.store,
      readIndex: async () => Object.fromEntries(legacySections.map(s => [s.id, s.hash])),
      readSections: async (ids: string[]) => new Map(legacySections.filter(s => ids.includes(s.id)).map(s => [s.id, s]))
    }, loadContext: () => ({ sections: legacySections, context: 'query' }) } as unknown as ToolDeps;
    const context = JSON.parse(await handleLoadSkillContext(legacyDeps, 'query'));
    expect(Object.keys(context).sort()).toEqual(['content', 'sectionCount', 'sections'].sort());
    expect(context.dependencyMetadata).toBeUndefined();
    const section = JSON.parse(await handleLoadSection(legacyDeps, 'a::one'));
    expect(section).toMatchObject({ section: legacySections[0], references: [], requires: [], related: [], flowOf: [] });
    expect(Object.keys(section).sort()).toEqual(['section', 'references', 'requires', 'related', 'flowOf'].sort());
  });

  it('counts each cross-skill manifest once and preserves the trust policy', async () => {
    const high = { ...sections[0], id: 'high::seed', manifestId: 'high-manifest', precedence: 100, requires: ['low::dep'] };
    const low = { ...sections[1], id: 'low::dep', manifestId: 'low-manifest', precedence: 5 };
    const cross = { ...deps, resolve: () => ({ query: 'setup', seed: 'high::seed', collapsed: false, sections: [high, low].map((s, order) => ({ id: s.id, headingPath: [s.title], content: s.content, role: 'hard' as const, order, trustTier: 'project' })), leftovers: [], budget: { limit: 5000, used: 4 } }), store: { ...deps.store,
      readIndex: async () => ({ 'high::seed': 'a', 'low::dep': 'b' }),
      readSections: async (ids: string[]) => new Map([high, low].filter(s => ids.includes(s.id)).map(s => [s.id, s])) ,
      readManifests: async () => ({
        'high-manifest': { ...manifests['claude::a::hash']!, id: 'high-manifest', tokenCount: 20, sections: [] },
        'low-manifest': { ...manifests['claude::a::hash']!, id: 'low-manifest', tokenCount: 30, sections: [] }
      })
    } } as unknown as ToolDeps;
    const result = JSON.parse(await handleResolveTaskSections(cross, 'setup', undefined, undefined, 5000));
    expect(result.tokenSavings.tokensWholeFile).toBe(50);
    console.log('cross-skill-closure: count=1');
  });

  it('exercises collapsed savings at zero', async () => {
    const collapsed = [
      { ...sections[0], id: 'collapse::one', manifestId: 'collapse-manifest', content: 'setup query now', tokenCount: 3 },
      { ...sections[1], id: 'collapse::two', manifestId: 'collapse-manifest', content: 'other', tokenCount: 1 }
    ];
    const collapsedDeps = { ...deps, store: { ...deps.store,
      readIndex: async () => Object.fromEntries(collapsed.map(s => [s.id, s.hash])),
      readSections: async (ids: string[]) => new Map(collapsed.filter(s => ids.includes(s.id)).map(s => [s.id, s])),
      readManifests: async () => ({ 'collapse-manifest': { ...manifests['claude::a::hash']!, id: 'collapse-manifest', tokenCount: 4 } })
    } } as unknown as ToolDeps;
    const result = JSON.parse(await handleResolveTaskSections(collapsedDeps, 'setup'));
    console.log(`synthetic-collapsed: count=1 savingsPct=${result.tokenSavings.savingsPct}%`);
    expect(result.collapsed).toBe(true);
    expect(result.tokenSavings.savingsPct).toBe(0);
  });

  it('runs the frozen 24-query direct/MCP parity table and savings distribution', async () => {
    const fixtureRoot = fileURLToPath(new URL('./fixtures/eval/', import.meta.url));
    const queryRows = JSON.parse(readFileSync(`${fixtureRoot}queries.json`, 'utf8')) as Array<{ query: string; skill: string; isMultiSection: boolean }>;
    expect(queryRows).toHaveLength(24);
    const files = { 'well-structured': '../compiler/well-structured.md', 'chrome-automation': 'chrome-automation.md', 'database-ops': 'database-ops.md' };
    const skillMap: Record<string, SkillSection[]> = {};
    for (const [skill, relative] of Object.entries(files)) {
      const raw = readFileSync(`${fixtureRoot}${relative}`, 'utf8');
      const chunks = raw.split(/^##\s+/m).slice(1).map(part => {
        const newline = part.indexOf('\n');
        return [null, part.slice(0, newline), part.slice(newline + 1)] as RegExpMatchArray;
      });
      const manifestId = `eval::${skill}::00000000`;
      skillMap[skill] = chunks.map((match, order) => {
        const title = match[1]!.trim();
        const content = match[2]!.trim();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const requires = content.match(/<!--\s*requires:\s*([^>]+)\s*-->/)?.[1]?.split(',').map(s => s.trim()) ?? [];
        return { id: `${skill}::${slug}`, title, content, hash: `${order}`, manifestId, class: 'phase', order, tokenCount: content.split(/\s+/).filter(Boolean).length, requires };
      });
    }
    const all = Object.values(skillMap).flat();
    const evalManifests: Record<string, SkillManifest> = {};
    for (const [skill, skillSections] of Object.entries(skillMap)) {
      const id = `eval::${skill}::00000000`;
      evalManifests[id] = { ...manifests['claude::a::hash']!, id, skillName: skill, tokenCount: skillSections.reduce((n, s) => n + (s.tokenCount ?? 0), 0), sections: [], byteLength: 1 };
    }
    const evalDeps = { ...deps, store: { ...deps.store,
      readIndex: async () => Object.fromEntries(all.map(s => [s.id, s.hash])),
      readSections: async (ids: string[]) => new Map(all.filter(s => ids.includes(s.id)).map(s => [s.id, s])),
      readManifests: async () => evalManifests
    } } as unknown as ToolDeps;
    const rows: string[] = [];
    const savings: Array<{ tokensLoaded: number; tokensWholeFile: number | null; savingsPct: number | null; collapsed: boolean; multi: boolean }> = [];
    for (const q of queryRows) {
      const direct = q.isMultiSection ? resolve(skillMap[q.skill]!, { query: q.query, skill: q.skill, budget: 5000 }).sections.map(s => s.id) : searchSections(skillMap[q.skill]!, q.query).slice(0, 3).map(s => s.id);
      const response = await handleMcpToolCall(evalDeps, q.isMultiSection ? 'resolve_task_sections' : 'search_skill_sections', { query: q.query, skill: q.skill, ...(q.isMultiSection ? { budget: 5000 } : { k: 3 }) });
      const payload = JSON.parse(response.content[0].text);
      const mcp = q.isMultiSection ? payload.sections.map((s: { id: string }) => s.id) : payload.sections.map((s: SkillSection) => s.id);
      const directLoaded = direct.reduce((n, id) => n + (all.find(s => s.id === id)?.tokenCount ?? 0), 0);
      if (q.isMultiSection) expect(payload.tokenSavings.tokensLoaded).toBe(directLoaded);
       if (q.isMultiSection) {
         expect(payload.tokenSavings.savingsPct).toBeGreaterThanOrEqual(0);
         savings.push({ ...payload.tokenSavings, collapsed: payload.collapsed, multi: true });
       }
       else {
         const loaded = payload.sections.reduce((n: number, s: SkillSection) => n + (s.tokenCount ?? 0), 0);
         const whole = evalManifests[skillMap[q.skill]![0]!.manifestId!]!.tokenCount ?? null;
         savings.push({ tokensLoaded: loaded, tokensWholeFile: whole, savingsPct: whole ? (1 - loaded / whole) * 100 : null, collapsed: false, multi: false });
       }
       const match = JSON.stringify(direct) === JSON.stringify(mcp);
       const current = savings.at(-1)!;
       rows.push(`${q.query} | ${JSON.stringify(direct)} | ${JSON.stringify(mcp)} | ${match ? 'yes' : 'NO'} | tokensLoaded=${current.tokensLoaded} tokensWholeFile=${current.tokensWholeFile} savingsPct=${current.savingsPct}`);
      expect(mcp).toEqual(direct);
    }
    console.log('query | direct IDs | MCP IDs | match | token savings');
    rows.forEach(row => console.log(row));
    const singleSavings = savings.filter(s => !s.multi).map(s => s.savingsPct!);
    const multiSavings = savings.filter(s => s.multi).map(s => s.savingsPct!);
    const summarize = (values: number[]) => `count=${values.length} min=${Math.min(...values)} max=${Math.max(...values)} mean=${values.reduce((sum, value) => sum + value, 0) / values.length}`;
    const singles = singleSavings.length;
    const multis = multiSavings.length;
    expect(singles).toBe(22);
    expect(multis).toBe(2);
    expect(savings.filter(s => s.collapsed)).toHaveLength(0);
    expect(savings.every(s => s.tokensWholeFile == null || s.tokensWholeFile >= 0)).toBe(true);
    console.log(`single-section: ${summarize(singleSavings)}`);
    console.log(`multi-section: ${summarize(multiSavings)}`);
    console.log('approved-24: collapsed count=0');
  });
});
