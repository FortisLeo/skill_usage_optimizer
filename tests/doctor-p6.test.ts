import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { doctor, MAX_SECTION_TOKENS } from '../src/resolver/doctor.js';
import { FileStore } from '../src/store/fileStore.js';
import { createToolDeps, handleMcpToolCall } from '../src/mcp/server.js';
import type { SkillManifest, SkillSection } from '../src/types.js';

const section = (id: string, content = 'body', extra: Partial<SkillSection> = {}): SkillSection => ({ id, title: id, content, hash: id, ...extra });

describe('P6 doctor', () => {
  it('reports cycles, dangling edges, trust direction, and strict size limits', () => {
    const exact = section('exact', new Array(MAX_SECTION_TOKENS - 1).fill('x').join(' '));
    const over = section('over', new Array(MAX_SECTION_TOKENS).fill('x').join(' '));
    const low = section('low', 'body', { precedence: 10, requires: ['high'] });
    const high = section('high', 'body', { precedence: 100, requires: ['low'] });
    const a = section('a', 'body', { requires: ['b'] });
    const b = section('b', 'body', { requires: ['a'] });
    const result = doctor([exact, over, low, high, a, b, section('dangling', 'body', { requires: ['gone'] })]);
    expect(result.status).toBe('errors');
    expect(result.diagnostics.map(d => d.code)).toEqual([...result.diagnostics].sort((x, y) => x.code.localeCompare(y.code)).map(d => d.code));
    expect(result.diagnostics.some(d => d.code === 'cycle' && d.severity === 'error')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'dangling_requires')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'trust_lower_to_higher' && d.severity === 'error')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'trust_higher_to_lower' && d.severity === 'warn')).toBe(true);
    expect(result.diagnostics.some(d => d.code === 'oversized_section')).toBe(true);
    expect(result.diagnostics.some(d => d.sectionId === 'exact')).toBe(false);
  });

  it('reports shadowed safety preambles and unreadable sources without mutating them', () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-p6-'));
    const shadowed = join(root, 'shadowed.md');
    writeFileSync(shadowed, '---\ntitle: x\n---\n<!-- note -->\nNever expose credentials.\n\n# Heading\nbody');
    const manifest: SkillManifest = {
      id: 'm', skillName: 'x', system: 'claude', kind: 'skill_package', description: null,
      sourcePath: shadowed, sourceHash: 'h', sections: [], tokenCount: 1, byteLength: 1,
      conflicts: [{ conflictKey: 'claude::x', winner: { system: 'claude', sourcePath: join(root, 'winner.md'), sourceHash: 'w' }, shadowed: [{ system: 'claude', sourcePath: shadowed, sourceHash: 's' }, { system: 'claude', sourcePath: join(root, 'missing.md'), sourceHash: 'm' }], reason: 'higher_precedence', winnerPrecedence: 100 }]
    };
    const before = readFileSync(shadowed);
    const result = doctor([], [manifest]);
    expect(result.diagnostics.map(d => d.code)).toEqual(['shadowed_safety_preamble', 'shadowed_source_unreadable']);
    expect(readFileSync(shadowed)).toEqual(before);
  });

  it('returns clean for an equal-tier, non-oversized corpus', () => {
    const result = doctor([section('one', 'ok', { precedence: 100, requires: ['two'] }), section('two', 'ok', { precedence: 100 })]);
    expect(result).toEqual({ status: 'clean', diagnostics: [] });
  });

  it('keeps CLI exit codes and MCP output on the shared report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doctor-p6-cli-'));
    const store = new FileStore(join(root, 'cache'));
    await store.init();
    const bad = section('bad', 'body', { requires: ['missing'] });
    await store.writeSections(new Map([[bad.id, bad]]));
    await store.writeIndex({ [bad.id]: bad.hash });
    await store.writeManifests({});
    const snapshot = () => new Map([
      [store.indexPath, readFileSync(store.indexPath)],
      [store.manifestsPath, readFileSync(store.manifestsPath)],
      ...readdirSync(store.sectionsDir).map(file => {
        const path = join(store.sectionsDir, file);
        return [path, readFileSync(path)] as const;
      }),
    ]);
    const before = snapshot();
    const jsonRun = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor', '--store', join(root, 'cache'), '--json'], { encoding: 'utf8' });
    expect(JSON.parse(jsonRun.stdout).status).toBe('errors');
    const run = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor', '--store', join(root, 'cache')], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    const mcp = await handleMcpToolCall(await createToolDeps({ storeDir: join(root, 'cache') }), 'doctor', {});
    expect(JSON.parse(mcp.content[0].text)).toEqual(JSON.parse(jsonRun.stdout));
    const after = snapshot();
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [path, contents] of before) expect(after.get(path)).toEqual(contents);
  });
});
