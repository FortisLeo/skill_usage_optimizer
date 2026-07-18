// ponytail: store unit tests
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore, SkillSection } from '../src/store/fileStore.js';
import type { SkillManifest } from '../src/types.js';

describe('FileStore', () => {
  let store: FileStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'file-store-test-'));
    store = new FileStore(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  describe('readIndex / writeIndex', () => {
    it('returns empty index when no file exists', async () => {
      const idx = await store.readIndex();
      expect(idx).toEqual({});
    });

    it('writes and reads index', async () => {
      await store.writeIndex({ 'skill-a': 'abc123', 'skill-b': 'def456' });
      const idx = await store.readIndex();
      expect(idx).toEqual({ 'skill-a': 'abc123', 'skill-b': 'def456' });
    });

    it('throws on malformed index.json', async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.json'), 'not-json', 'utf-8');
      await expect(store.readIndex()).rejects.toThrow();
    });

    it('overwrites index on subsequent writes', async () => {
      await store.writeIndex({ a: '1' });
      await store.writeIndex({ b: '2' });
      expect(await store.readIndex()).toEqual({ b: '2' });
    });
  });

  describe('readSections / writeSections', () => {
    const sectionA: SkillSection = { id: 'skill-a', title: 'Skill A', content: '# A', hash: 'aaa' };
    const sectionB: SkillSection = { id: 'skill-b', title: 'Skill B', content: '# B', hash: 'bbb' };

    it('writes and reads sections', async () => {
      const withMeta: SkillSection = { ...sectionA, system: 'claude', sourcePath: '/tmp/a.md', sourceHash: 'src', mtimeMs: 1, size: 2 };
      const m = new Map<string, SkillSection>();
      m.set('skill-a', withMeta);
      m.set('skill-b', sectionB);
      await store.writeSections(m);

      const result = await store.readSections(['skill-a', 'skill-b']);
      expect(result.get('skill-a')).toEqual(withMeta);
      expect(result.get('skill-b')).toEqual(sectionB);
    });

    it('returns only requested sections, skipping missing', async () => {
      const m = new Map<string, SkillSection>();
      m.set('skill-a', sectionA);
      await store.writeSections(m);

      const result = await store.readSections(['skill-a', 'nonexistent']);
      expect(result.size).toBe(1);
      expect(result.get('skill-a')).toEqual(sectionA);
    });

    it('does not collide on similar unsafe IDs', async () => {
      // Under the old underscore encoding, 'a/b' and 'a:b' would both map to 'a_b.json'.
      // base64url encoding ensures they are distinct.
      const idForwardSlash = 'a/b';
      const idColon = 'a:b';
      const idQuestion = 'a?b';

      const s1: SkillSection = { id: idForwardSlash, title: 'FS', content: '# FS', hash: 'h1' };
      const s2: SkillSection = { id: idColon, title: 'Colon', content: '# Col', hash: 'h2' };
      const s3: SkillSection = { id: idQuestion, title: 'Q', content: '# Q', hash: 'h3' };

      const m = new Map<string, SkillSection>();
      m.set(idForwardSlash, s1);
      m.set(idColon, s2);
      m.set(idQuestion, s3);
      await store.writeSections(m);

      const result = await store.readSections([idForwardSlash, idColon, idQuestion]);
      expect(result.size).toBe(3);
      expect(result.get(idForwardSlash)).toEqual(s1);
      expect(result.get(idColon)).toEqual(s2);
      expect(result.get(idQuestion)).toEqual(s3);
    });

    it('throws on malformed section JSON', async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const sectionsDir = join(dir, 'sections');
      mkdirSync(sectionsDir, { recursive: true });
      // ponytail: must use the same base64url encoding as FileStore.encodeFilename
      const encoded = Buffer.from('bad', 'utf-8').toString('base64url');
      writeFileSync(join(sectionsDir, encoded + '.json'), 'not-json', 'utf-8');
      await expect(store.readSections(['bad'])).rejects.toThrow();
    });
  });

  describe('clear', () => {
    it('removes all files', async () => {
      await store.writeIndex({ a: '1' });
      const section: SkillSection = { id: 'a', title: 'A', content: '# A', hash: 'aaa' };
      const m = new Map<string, SkillSection>();
      m.set('a', section);
      await store.writeSections(m);
      // Verify files exist
      expect(await store.readIndex()).not.toEqual({});

      await store.clear();
      expect(await store.readIndex()).toEqual({});
    });
  });

  describe('readManifests / writeManifests', () => {
    const fixture: SkillManifest = {
      id: 'skill-1',
      skillName: 'skill-1',
      system: 'claude',
      kind: 'skill_package',
      description: 'Stored skill',
      sourcePath: '/tmp/skill-1.md',
      sourceHash: 'src123',
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

    it('returns empty when no manifests file exists', async () => {
      const result = await store.readManifests();
      expect(result).toEqual({});
    });

    it('writes and reads manifests', async () => {
      await store.writeManifests({ 'skill-1': fixture });
      const result = await store.readManifests();
      expect(result['skill-1']).toEqual(fixture);
    });

    it('persists manifests across store objects (same dir)', async () => {
      await store.writeManifests({ 'skill-1': fixture });
      const store2 = new FileStore(dir);
      const result = await store2.readManifests();
      expect(result['skill-1']).toEqual(fixture);
    });

    it('clear removes manifests', async () => {
      await store.writeManifests({ 'skill-1': fixture });
      await store.clear();
      expect(await store.readManifests()).toEqual({});
    });
  });

  it('migrates legacy savings records to a persisted v3 envelope across store objects', async () => {
    const records = [{ tokenSavings: { tokensLoaded: 2, tokensWholeFile: 10, savingsPct: 80 }, multi: false, collapsed: false }];
    await store.writeSavings(records);
    const savings = await new FileStore(dir).readSavings();
    expect(savings).toMatchObject({ version: 3, records: [{ baselineTokens: 10, sentTokens: 2, savedTokens: 8 }], lifetime: { calls: 1, baselineTokens: 10, sentTokens: 2, savedTokens: 8, reductionPct: 80 }, sessionTotals: { legacy: { calls: 1, baselineTokens: 10, sentTokens: 2, savedTokens: 8, reductionPct: 80 } } });
    await store.writeSavings({ records });
    expect((await new FileStore(dir).readSavings()).lifetime).toMatchObject({ calls: 1, baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
  });

  it('keeps cumulative savings totals after pruning record history', async () => {
    for (let i = 0; i < 101; i++) await store.updateSavings({ baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
    const savings = await new FileStore(dir).readSavings();
    expect(savings.records).toHaveLength(100);
    expect(savings.lifetime).toEqual({ calls: 101, baselineTokens: 1010, sentTokens: 202, savedTokens: 808, reductionPct: 80 });
    expect(savings.activeSession).toMatchObject({ calls: 101, baselineTokens: 1010, sentTokens: 202, savedTokens: 808, reductionPct: 80 });
  });

  it('persists cumulative totals for named sessions beyond capped history', async () => {
    for (let i = 0; i < 120; i++) await store.updateSavings({ sessionId: i % 2 ? 'alpha' : 'beta', baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
    const savings = await new FileStore(dir).readSavings();
    expect(savings.records).toHaveLength(100);
    expect(savings.sessionTotals.alpha).toMatchObject({ calls: 60, baselineTokens: 600, sentTokens: 120, savedTokens: 480 });
    expect(savings.sessionTotals.beta).toMatchObject({ calls: 60, baselineTokens: 600, sentTokens: 120, savedTokens: 480 });
    expect((await new FileStore(dir).updateSavings({ sessionId: 'alpha' })).activeSession).toMatchObject({ id: 'alpha', calls: 60, savedTokens: 480 });
  });

  it('preserves savings when clearing the index and does not drop concurrent updates', async () => {
    await store.updateSavings({ baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
    await store.writeIndex({ a: '1' });
    await store.clearIndex();
    expect(await store.readIndex()).toEqual({});
    await Promise.all(Array.from({ length: 20 }, () => new FileStore(dir).updateSavings({ baselineTokens: 10, sentTokens: 4, savedTokens: 6 })));
    expect((await new FileStore(dir).readSavings()).lifetime).toMatchObject({ calls: 21, baselineTokens: 210, sentTokens: 82, savedTokens: 128 });
  });

  it('recovers only stale, identifiable savings locks', async () => {
    const lockPath = join(dir, '.savings.lock');
    writeFileSync(lockPath, JSON.stringify({ token: 'abandoned', pid: 99_999_999, createdAt: Date.now() - 31_000 }));
    await store.updateSavings({ baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
    expect(await store.readSavings()).toMatchObject({ lifetime: { calls: 1 } });

    writeFileSync(lockPath, JSON.stringify({ token: 'active-owner', pid: process.pid, createdAt: Date.now() }));
    await expect(store.updateSavings({ baselineTokens: 10, sentTokens: 2, savedTokens: 8 })).rejects.toThrow('savings lock timed out');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'active-owner' });
  });

  it('cleans up the savings queue after completion and rejection', async () => {
    const queues = (FileStore as unknown as { savingsQueues: Map<string, Promise<void>> }).savingsQueues;
    await store.updateSavings({ baselineTokens: 10, sentTokens: 2, savedTokens: 8 });
    expect(queues.has(dir)).toBe(false);

    writeFileSync(store.savingsPath, 'not-json');
    await expect(store.updateSavings()).rejects.toThrow();
    expect(queues.has(dir)).toBe(false);
  });

  describe('atomic writes', () => {
    it('does not leave .tmp files after writeIndex', async () => {
      await store.writeIndex({ a: '1' });
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(dir);
      expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    });

    it('does not leave .tmp files after writeSections', async () => {
      const section: SkillSection = { id: 'a', title: 'A', content: '# A', hash: 'aaa' };
      const m = new Map<string, SkillSection>();
      m.set('a', section);
      await store.writeSections(m);
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(join(dir, 'sections'));
      expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    });
  });
});
