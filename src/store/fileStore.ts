import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { SkillManifest, SkillSection } from '../types.js';

export type { SkillSection } from '../types.js';

export type SkillStore = Map<string, SkillSection>;

/** Encodes a skill ID to a collision-safe filename segment using base64url. */
function encodeFilename(id: string): string {
  return Buffer.from(id, 'utf-8').toString('base64url');
}

/** Atomic write: write to a temp file in the same directory, then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, filePath);
}

export class FileStore {
  constructor(private baseDir: string) {}

  get indexPath(): string {
    return join(this.baseDir, 'index.json');
  }

  get sectionsDir(): string {
    return join(this.baseDir, 'sections');
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await mkdir(this.sectionsDir, { recursive: true });
  }

  async readIndex(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('index.json must be a JSON object');
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string') {
          throw new Error(`index entry "${k}" value must be a string`);
        }
      }
      return parsed as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  async writeIndex(entries: Record<string, string>): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const json = JSON.stringify(entries, null, 2);
    await atomicWrite(this.indexPath, json);
  }

  async readSections(ids: string[]): Promise<Map<string, SkillSection>> {
    const result = new Map<string, SkillSection>();
    for (const id of ids) {
      const filename = encodeFilename(id) + '.json';
      const path = join(this.sectionsDir, filename);
      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error(`section "${id}" is not a valid JSON object`);
        }
        if (typeof parsed.id !== 'string' || typeof parsed.title !== 'string' ||
            typeof parsed.content !== 'string' || typeof parsed.hash !== 'string') {
          throw new Error(`section "${id}" missing required fields`);
        }
        if ((parsed.system !== undefined && typeof parsed.system !== 'string') ||
            (parsed.sourcePath !== undefined && typeof parsed.sourcePath !== 'string') ||
            (parsed.sourceHash !== undefined && typeof parsed.sourceHash !== 'string') ||
            (parsed.mtimeMs !== undefined && typeof parsed.mtimeMs !== 'number') ||
            (parsed.size !== undefined && typeof parsed.size !== 'number')) {
          throw new Error(`section "${id}" has invalid metadata`);
        }
        result.set(parsed.id, parsed as SkillSection);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    return result;
  }

  async writeSections(sections: Map<string, SkillSection>): Promise<void> {
    await mkdir(this.sectionsDir, { recursive: true });
    for (const [id, section] of sections) {
      const filename = encodeFilename(id) + '.json';
      const path = join(this.sectionsDir, filename);
      const json = JSON.stringify(section);
      await atomicWrite(path, json);
    }
  }

  get manifestsPath(): string {
    return join(this.baseDir, 'manifests.json');
  }

  async readManifests(): Promise<Record<string, SkillManifest>> {
    try {
      const raw = await readFile(this.manifestsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('manifests.json must be a JSON object');
      }
      return parsed as Record<string, SkillManifest>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw err;
    }
  }

  async writeManifests(manifests: Record<string, SkillManifest>): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const json = JSON.stringify(manifests, null, 2);
    await atomicWrite(this.manifestsPath, json);
  }

  async clear(): Promise<void> {
    try { await rm(this.baseDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
