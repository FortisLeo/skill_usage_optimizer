import { readFile, writeFile, rename, mkdir, rm, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { SkillManifest, SkillSection } from '../types.js';

export type { SkillSection } from '../types.js';

export type SkillStore = Map<string, SkillSection>;

export interface SavingsTotals { calls: number; baselineTokens: number; sentTokens: number; savedTokens: number; reductionPct: number; }
export interface SavingsSession extends SavingsTotals { id: string; }
export interface SavingsRecord { sessionId: string; baselineTokens: number; sentTokens: number; savedTokens: number; }
export interface SavingsEnvelope { version: 3; records: SavingsRecord[]; lifetime: SavingsTotals; activeSession: SavingsSession; sessionTotals: Record<string, SavingsTotals>; }
export interface SavingsUpdate { baselineTokens?: number; sentTokens?: number; savedTokens?: number; sessionId?: string; newSession?: boolean; }

const EMPTY_TOTALS = (): SavingsTotals => ({ calls: 0, baselineTokens: 0, sentTokens: 0, savedTokens: 0, reductionPct: 0 });
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 30_000;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const totals = (records: SavingsRecord[]): SavingsTotals => {
  const result = records.reduce((sum, record) => ({ calls: sum.calls + 1, baselineTokens: sum.baselineTokens + record.baselineTokens, sentTokens: sum.sentTokens + record.sentTokens, savedTokens: sum.savedTokens + record.savedTokens, reductionPct: 0 }), EMPTY_TOTALS());
  result.reductionPct = result.baselineTokens === 0 ? 0 : Math.max(0, Math.min(100, result.savedTokens / result.baselineTokens * 100));
  return result;
};
const addRecord = (total: SavingsTotals, record: SavingsRecord): SavingsTotals => {
  const baselineTokens = total.baselineTokens + record.baselineTokens;
  const savedTokens = total.savedTokens + record.savedTokens;
  return { calls: total.calls + 1, baselineTokens, sentTokens: total.sentTokens + record.sentTokens, savedTokens, reductionPct: baselineTokens === 0 ? 0 : Math.max(0, Math.min(100, savedTokens / baselineTokens * 100)) };
};
const validTotals = (value: unknown): SavingsTotals | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const total = value as Record<string, unknown>;
  if (!isNumber(total.calls) || !isNumber(total.baselineTokens) || !isNumber(total.sentTokens) || !isNumber(total.savedTokens)) return undefined;
  return { calls: total.calls, baselineTokens: total.baselineTokens, sentTokens: total.sentTokens, savedTokens: total.savedTokens, reductionPct: total.baselineTokens === 0 ? 0 : Math.max(0, Math.min(100, total.savedTokens / total.baselineTokens * 100)) };
};
const validRecord = (value: unknown): SavingsRecord | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const savings = record.tokenSavings && typeof record.tokenSavings === 'object' ? record.tokenSavings as Record<string, unknown> : record;
  const baselineTokens = savings.baselineTokens ?? savings.tokensWholeFile;
  const sentTokens = savings.sentTokens ?? savings.tokensLoaded;
  const savedTokens = savings.savedTokens ?? (isNumber(baselineTokens) && isNumber(sentTokens) ? Math.max(baselineTokens - sentTokens, 0) : undefined);
  if (!isNumber(baselineTokens) || !isNumber(sentTokens) || !isNumber(savedTokens)) return undefined;
  return { sessionId: typeof record.sessionId === 'string' ? record.sessionId : 'legacy', baselineTokens, sentTokens, savedTokens: Math.min(savedTokens, baselineTokens) };
};
const validSessionTotals = (value: unknown): Record<string, SavingsTotals> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, total]) => {
    const parsed = validTotals(total);
    return parsed ? [[id, parsed]] : [];
  }));
};
const isStaleLock = (value: unknown): value is { token: string; createdAt: number; pid: number } => {
  if (!value || typeof value !== 'object') return false;
  const lock = value as Record<string, unknown>;
  const pid = lock.pid;
  if (typeof lock.token !== 'string' || lock.token.length === 0 || typeof lock.createdAt !== 'number' || !Number.isFinite(lock.createdAt) || lock.createdAt > Date.now() - LOCK_STALE_MS || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
};

/** Encodes a skill ID to a collision-safe filename segment using base64url. */
function encodeFilename(id: string): string {
  return Buffer.from(id, 'utf-8').toString('base64url');
}

/** Atomic write: write to a temp file in the same directory, then rename. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, filePath);
}

export class FileStore {
  private static savingsQueues = new Map<string, Promise<void>>();
  private static indexQueues = new Map<string, Promise<void>>();
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

  async withIndexLock<T>(action: () => Promise<T>): Promise<T> {
    return this.withFileLock('index', FileStore.indexQueues, action);
  }

  private async withFileLock<T>(name: 'index' | 'savings', queue: Map<string, Promise<void>>, action: () => Promise<T>): Promise<T> {
    const previous = queue.get(this.baseDir) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    queue.set(this.baseDir, queued);
    await previous;
    const lockPath = join(this.baseDir, `.${name}.lock`);
    const lockToken = randomUUID();
    let ownsLock = false;
    try {
      await mkdir(this.baseDir, { recursive: true });
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      for (;;) {
        try {
          const lock = await open(lockPath, 'wx');
          await lock.writeFile(JSON.stringify({ token: lockToken, pid: process.pid, createdAt: Date.now() }));
          await lock.close();
          ownsLock = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const reclaimPath = `${lockPath}.reclaim`;
          let reclaim: Awaited<ReturnType<typeof open>> | undefined;
          try {
            reclaim = await open(reclaimPath, 'wx');
            const existing = JSON.parse(await readFile(lockPath, 'utf-8'));
            if (isStaleLock(existing)) {
              const recoveryPath = `${lockPath}.${process.pid}.${randomUUID()}.recovery`;
              await rename(lockPath, recoveryPath);
              const recovered = JSON.parse(await readFile(recoveryPath, 'utf-8'));
              if (recovered?.token === existing.token) await unlink(recoveryPath);
            }
          } catch (readError) {
            if (!['EEXIST', 'ENOENT'].includes((readError as NodeJS.ErrnoException).code ?? '')) { /* An incomplete or invalid lock is never safe to recover. */ }
          } finally {
            if (reclaim) {
              await reclaim.close().catch(() => {});
              await unlink(reclaimPath).catch(() => {});
            }
          }
          if (Date.now() >= deadline) throw new Error(`${name} lock timed out`);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      return await action();
    } finally {
      if (ownsLock) {
        try {
          const existing = JSON.parse(await readFile(lockPath, 'utf-8'));
          if (existing?.token === lockToken) await unlink(lockPath);
        } catch { /* The lock was already released or safely recovered. */ }
      }
      release();
      if (queue.get(this.baseDir) === queued) queue.delete(this.baseDir);
    }
  }

  get savingsPath(): string {
    return join(this.baseDir, 'savings.json');
  }

  async readSavings(): Promise<SavingsEnvelope> {
    for (const name of ['savings.json', 'checkout.json']) {
      try { return this.toSavingsEnvelope(JSON.parse(await readFile(join(this.baseDir, name), 'utf-8'))); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
    return this.toSavingsEnvelope([]);
  }

  private toSavingsEnvelope(value: unknown): SavingsEnvelope {
    const raw = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { records?: unknown }).records) ? (value as { records: unknown[] }).records : [];
    const allRecords = raw.map(validRecord).filter((record): record is SavingsRecord => !!record);
    const records = allRecords.slice(-100);
    const envelope = value && typeof value === 'object' ? value as { version?: unknown; lifetime?: unknown; activeSession?: { id?: unknown }; sessionTotals?: unknown } : undefined;
    const activeId = typeof envelope?.activeSession?.id === 'string' ? envelope.activeSession.id : randomUUID();
    const activeRecords = allRecords.filter(record => record.sessionId === activeId);
    // A buggy v2 file has already discarded its older totals; retain its persisted values rather than guessing them.
    const sessionTotals = validSessionTotals(envelope?.sessionTotals);
    const recordedSessionTotals: Record<string, SavingsTotals> = {};
    for (const record of allRecords) recordedSessionTotals[record.sessionId] = addRecord(recordedSessionTotals[record.sessionId] ?? EMPTY_TOTALS(), record);
    for (const [id, total] of Object.entries(recordedSessionTotals)) sessionTotals[id] ??= total;
    sessionTotals[activeId] = envelope?.version === 2
      ? validTotals(envelope.activeSession) ?? sessionTotals[activeId] ?? totals(activeRecords)
      : sessionTotals[activeId] ?? validTotals(envelope?.activeSession) ?? totals(activeRecords);
    return { version: 3, records, lifetime: envelope?.version === 2 || envelope?.version === 3 ? validTotals(envelope.lifetime) ?? totals(allRecords) : totals(allRecords), activeSession: { id: activeId, ...sessionTotals[activeId]! }, sessionTotals };
  }

  async writeSavings(value: unknown): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await atomicWrite(this.savingsPath, JSON.stringify(this.toSavingsEnvelope(value), null, 2));
  }

  async updateSavings(update: SavingsUpdate = {}): Promise<SavingsEnvelope> {
    return this.withFileLock('savings', FileStore.savingsQueues, async () => {
      const envelope = await this.readSavings();
      const activeId = update.newSession ? randomUUID() : envelope.activeSession.id;
      const sessionId = update.sessionId ?? activeId;
      if (update.newSession) {
        envelope.activeSession = { id: activeId, ...EMPTY_TOTALS() };
        envelope.sessionTotals[activeId] = EMPTY_TOTALS();
      }
      if (isNumber(update.baselineTokens) && isNumber(update.sentTokens) && isNumber(update.savedTokens)) {
        const record = { sessionId, baselineTokens: update.baselineTokens, sentTokens: update.sentTokens, savedTokens: Math.min(update.savedTokens, update.baselineTokens) };
        envelope.records.push(record);
        envelope.lifetime = addRecord(envelope.lifetime, record);
        envelope.sessionTotals[sessionId] = addRecord(envelope.sessionTotals[sessionId] ?? EMPTY_TOTALS(), record);
        if (sessionId === activeId) envelope.activeSession = { id: activeId, ...envelope.sessionTotals[activeId]! };
      }
      envelope.records = envelope.records.slice(-100);
      await atomicWrite(this.savingsPath, JSON.stringify(envelope, null, 2));
      return update.sessionId && !update.newSession ? { ...envelope, activeSession: { id: update.sessionId, ...(envelope.sessionTotals[update.sessionId] ?? EMPTY_TOTALS()) } } : envelope;
    });
  }

  async clearIndex(): Promise<void> {
    await Promise.all([rm(this.indexPath, { force: true }), rm(this.sectionsDir, { recursive: true, force: true }), rm(this.manifestsPath, { force: true })]);
  }

  async clear(): Promise<void> {
    try { await rm(this.baseDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
