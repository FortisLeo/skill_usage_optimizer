import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { computeHash } from '../src/fs/freshness.js';
import { createToolDeps, handleMcpToolCall } from '../src/mcp/server.js';
import { handleResolveTaskSections, handleSearchSkillSections } from '../src/mcp/tools.js';
import { startWatch, stats, runCli } from '../src/cli.js';
import type { ToolDeps } from '../src/mcp/tools.js';

function deps(): ToolDeps {
  const sourcePath = join(mkdtempSync(join(tmpdir(), 'cli-p5-')), 'skill.md');
  writeFileSync(sourcePath, '# setup');
  const stat = statSync(sourcePath);
  const section = { id: 'skill::setup', title: 'Setup', content: '# setup', hash: 'h', manifestId: 'skill', sourcePath, sourceHash: computeHash('# setup'), mtimeMs: stat.mtimeMs, size: stat.size };
  const store = {
    readIndex: async () => ({ [section.id]: section.hash }), writeIndex: async () => {},
    readSections: async () => new Map([[section.id, section]]), writeSections: async () => {},
    readManifests: async () => ({}), writeManifests: async () => {}, clear: async () => {},
    readSavings: async () => []
  };
  return { discover: () => ({ artifacts: [], errors: [] }), normalize: () => ({ inputs: [], errors: [] }), compile: () => ({ store: new Map(), errors: [] }), loadContext: () => ({ sections: [], context: '' }), store, resolveHomeDir: () => '', resolveWorkspaceRoot: () => '' };
}

function instrumentationDeps(records: unknown[] = [], writeSavings: (records: unknown) => Promise<void> = async next => { records.splice(0, records.length, ...(next as unknown[])); }): ToolDeps {
  const section = { id: 'skill::setup', title: 'Setup', content: 'setup query', hash: 'h', manifestId: 'skill', tokenCount: 2 };
  return {
    ...deps(),
    store: {
      ...deps().store,
      readIndex: async () => ({ [section.id]: section.hash }),
      readSections: async () => new Map([[section.id, section]]),
      readManifests: async () => ({ skill: { id: 'skill', skillName: 'skill', system: 'claude', kind: 'skill_package', description: null, sourcePath: '', sourceHash: '', sections: [], tokenCount: 10, byteLength: 1 } }),
      readSavings: async () => records,
      writeSavings
    }
  };
}

async function capture(argv: string[], d: ToolDeps): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try { expect(await runCli(argv, d)).toBe(0); return lines.join('\n'); }
  finally { console.log = log; }
}

function executable(argv: string[], cwd: string): string {
  return execFileSync(process.execPath, [resolve('dist/cli.js'), ...argv], { cwd, encoding: 'utf8' });
}

async function realFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cli-p5-real-'));
  const source = join(root, 'skills');
  mkdirSync(source);
  for (const name of ['well-structured', 'chrome-automation', 'database-ops']) {
    const fixtureDir = name === 'well-structured' ? 'tests/fixtures/compiler' : 'tests/fixtures/eval';
    const raw = readFileSync(resolve(fixtureDir, `${name}.md`), 'utf8');
    const content = raw.slice(raw.indexOf('## Setup')).replace(name === 'well-structured' ? /^### .*$/gm : /^$/, '');
    const targetDir = name === 'well-structured' ? join(source, name) : source;
    if (name === 'well-structured') mkdirSync(targetDir);
    writeFileSync(join(targetDir, name === 'well-structured' ? 'SKILL.md' : `${name}.md`), content);
  }
  const storeDir = join(root, '.cache');
  return { root, source, storeDir, deps: await createToolDeps({ storeDir, workspaceRoot: root, homeDir: join(root, 'empty-home') }) };
}

describe('P5 CLI', () => {
  it('help documents both get forms and reserved P6 doctor codes', async () => {
    const output = await capture(['--help'], deps());
    expect(output).toContain('get <skill>#<section>');
    expect(output).toContain('get <skill>');
    expect(output).toContain('reserved P6');
    expect(output).toContain('0 clean, 1 warnings, 2 errors');
  });

  it('compares all 24 frozen search and resolve queries against MCP dispatch', async () => {
    const fixture = await realFixture();
    await handleMcpToolCall(fixture.deps, 'index_skills', { system: 'claude', roots: [fixture.source], force: true });
    const cliIndex = JSON.parse(executable(['index', '--path', fixture.source, '--store', fixture.storeDir, '--force', '--json'], fixture.root));
    const mcpIndex = JSON.parse((await handleMcpToolCall(fixture.deps, 'index_skills', { system: 'claude', roots: [fixture.source], force: true })).content[0].text);
    // The external CLI process intentionally uses its own host discovery roots.
    expect(cliIndex.errors).toEqual(mcpIndex.errors);
    const skillId = Object.values(await fixture.deps.store.readManifests()).find(m => m.skillName === 'well-structured')!.id;
    expect(JSON.parse(executable(['get', skillId, '--store', fixture.storeDir, '--json'], fixture.root))).toEqual(JSON.parse((await handleMcpToolCall(fixture.deps, 'get_skill_sections', { skillId })).content[0].text));
    const setupId = [...(await fixture.deps.store.readSections(Object.keys(await fixture.deps.store.readIndex()))).values()].find(s => s.manifestId === skillId && s.title.toLowerCase() === 'setup')!.id;
    expect(JSON.parse(executable(['get', `${skillId}#${setupId}`, '--store', fixture.storeDir, '--json'], fixture.root))).toEqual(JSON.parse((await handleMcpToolCall(fixture.deps, 'load_section', { sectionId: setupId })).content[0].text));
    const queries = JSON.parse(readFileSync(resolve('tests/fixtures/eval/queries.json'), 'utf8')) as { query: string; skill: string }[];
    const indexed = [...(await fixture.deps.store.readSections(Object.keys(await fixture.deps.store.readIndex()))).values()];
    const rows: string[] = ['query | search | resolve'];
    for (const q of queries) {
      const searchArgs = { query: q.query, skill: q.skill, k: 3 };
      const resolveArgs = { query: q.query, skill: q.skill, budget: 5000 };
      const cliSearch = JSON.parse(await capture(['search', q.query, '--skill', q.skill, '--k', '3', '--json'], fixture.deps));
      const mcpSearch = JSON.parse((await handleMcpToolCall(fixture.deps, 'search_skill_sections', searchArgs)).content[0].text);
      const cliResolve = JSON.parse(await capture(['resolve', q.query, '--skill', q.skill, '--budget', '5000', '--json'], fixture.deps));
      const mcpResolve = JSON.parse((await handleMcpToolCall(fixture.deps, 'resolve_task_sections', resolveArgs)).content[0].text);
      expect(cliSearch).toEqual(mcpSearch);
      expect(cliResolve).toEqual(mcpResolve);
      const actual = (q.isMultiSection ? cliResolve.sections : cliSearch.sections).map((s: { id: string }) => s.id.split('::').at(-1)!.split('--').at(-1));
      expect(q.expectedSectionIds.every(id => indexed.some(s => s.id.split('::').at(-1)!.split('--').at(-1) === id)), `${q.query}: frozen IDs missing`).toBe(true);
      rows.push(`${q.skill}: ${q.query} | pass | pass`);
    }
    console.info(rows.join('\n'));
    expect(rows).toHaveLength(25);
  }, 120000);

  it('keeps serialized JSON stable across independent repeated CLI invocations', async () => {
    const fixture = await realFixture();
    await handleMcpToolCall(fixture.deps, 'index_skills', { system: 'claude', roots: [fixture.source], force: true });
    const first = await capture(['search', 'setup instructions', '--skill', 'well-structured', '--json'], await createToolDeps({ storeDir: fixture.storeDir, workspaceRoot: fixture.root, homeDir: join(fixture.root, 'empty-home') }));
    const second = await capture(['search', 'setup instructions', '--skill', 'well-structured', '--json'], await createToolDeps({ storeDir: fixture.storeDir, workspaceRoot: fixture.root, homeDir: join(fixture.root, 'empty-home') }));
    expect(first).toBe(second);
    const resolve1 = await capture(['resolve', 'setup instructions', '--skill', 'well-structured', '--json'], fixture.deps);
    const resolve2 = await capture(['resolve', 'setup instructions', '--skill', 'well-structured', '--json'], fixture.deps);
    expect(resolve1).toBe(resolve2);
    const skillId = Object.values(await fixture.deps.store.readManifests()).find(m => m.skillName === 'well-structured')!.id;
    expect(await capture(['get', skillId, '--json'], fixture.deps)).toBe(await capture(['get', skillId, '--json'], fixture.deps));
    const setupId = [...(await fixture.deps.store.readSections(Object.keys(await fixture.deps.store.readIndex()))).values()].find(s => s.manifestId === skillId && s.title.toLowerCase() === 'setup')!.id;
    expect(await capture(['get', `${skillId}#${setupId}`, '--json'], fixture.deps)).toBe(await capture(['get', `${skillId}#${setupId}`, '--json'], fixture.deps));
    expect(executable(['index', '--path', fixture.source, '--store', fixture.storeDir, '--force', '--json'], fixture.root)).toBe(executable(['index', '--path', fixture.source, '--store', fixture.storeDir, '--force', '--json'], fixture.root));
    expect(await capture(['stats', '--json'], fixture.deps)).toBe(await capture(['stats', '--json'], fixture.deps));
  }, 120000);

  it('persists resolve savings for a fresh CLI stats process', async () => {
    const fixture = await realFixture();
    executable(['index', '--path', fixture.source, '--store', fixture.storeDir, '--force', '--json'], fixture.root);
    executable(['resolve', 'setup instructions for the skill', '--skill', 'well-structured', '--store', fixture.storeDir, '--json'], fixture.root);
    const result = JSON.parse(executable(['stats', '--store', fixture.storeDir, '--json'], fixture.root));
    expect(result.label).toBe('Ruleloom estimated token proxy');
    expect(result.recordCount).toBe(1);
    expect(result.lifetime.calls).toBe(1);
    expect(result.session.calls).toBe(1);
  });

  it('passes session options through CLI validation', async () => {
    const output = await capture(['resolve', 'setup query', '--session-id', 'session_1', '--new-session', '--json'], deps());
    expect(JSON.parse(output).errors).toContain('sessionId and newSession cannot be used together');
  });

  it('returns zero stats for an empty fresh checkout', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'cli-p5-empty-'));
    const empty = await createToolDeps({ storeDir, workspaceRoot: storeDir, homeDir: storeDir });
    const result = JSON.parse(await stats(empty.store));
    expect(result.indexedSections).toBe(0);
    expect(result.records).toBe(0);
    expect(result.distribution).toEqual({ single: { count: 0, savingsPct: [] }, multi: { count: 0, savingsPct: [] }, collapsed: { count: 0, savingsPct: [] } });
  });

  it('debounces two rapid writes into one serialized reindex of final content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-watch-'));
    const sourceDir = join(root, 'nested');
    mkdirSync(sourceDir);
    const source = join(sourceDir, 'SKILL.md');
    writeFileSync(source, '# Initial\ninitial content');
    const storeDir = join(root, '.cache');
    const d = await createToolDeps({ storeDir, workspaceRoot: root, homeDir: join(root, 'empty-home') });
    let indexes = 0;
    const discover = d.discover;
    d.discover = ctx => { indexes++; return discover(ctx); };
    const watcher = startWatch(d, 'claude', sourceDir, 100);
    writeFileSync(source, '# One\none content');
    writeFileSync(source, '# Final\nfinal content');
    await new Promise(resolve => setTimeout(resolve, 300));
    watcher.close();
    await watcher.done;
    expect(indexes).toBe(1);
    const index = await d.store.readIndex();
    const sections = await d.store.readSections(Object.keys(index));
    expect([...sections.values()].some(section => section.content.includes('final content'))).toBe(true);
  });
});
