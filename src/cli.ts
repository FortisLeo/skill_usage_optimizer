#!/usr/bin/env node
import { watch as fsWatch } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { computeHash, readSourceFile, statFile } from './fs/freshness.js';
import { FileStore } from './store/fileStore.js';
import { createToolDeps } from './mcp/server.js';
import { handleDoctor, handleIndexSkills } from './mcp/tools.js';
import { handleMcpToolCall } from './mcp/server.js';
import type { ToolDeps } from './mcp/tools.js';

const HELP = `Usage: ruleloom <command> [options]

Commands:
  index [--system NAME] [--path DIR] [--force]
  search <query> [--phase NAME] [--skill NAME] [--k N] [--json]
  resolve <query> [--phase NAME] [--skill NAME] [--budget N] [--no-soft] [--json]
  get <skill>#<section> [--json]   (maps to load_section)
  get <skill> [--json]             (maps to get_skill_sections)
  doctor [--json]                  (reserved P6 exit contract: 0 clean, 1 warnings, 2 errors)
  watch [--system NAME] [--path DIR]
  stats [--json]

The --json flag selects deterministic JSON output; command handlers are shared with MCP.`;

function value(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function has(args: string[], name: string): boolean { return args.includes(name); }
function required(args: string[], name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`missing value for ${name}`);
  return result;
}
function positional(args: string[]): string[] { return args.filter((arg, i) => !arg.startsWith('--') && (i === 0 || !args[i - 1]!.startsWith('--'))); }

export async function stats(store: Pick<FileStore, 'readIndex' | 'readSections'> & { readSavings?: () => Promise<unknown> }): Promise<string> {
  const index = await store.readIndex();
  const sections = await store.readSections(Object.keys(index));
  const raw = store.readSavings ? await store.readSavings() : [];
  const records = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as any).records) ? (raw as any).records : []);
  const distribution = { single: { count: 0, savingsPct: [] as number[] }, multi: { count: 0, savingsPct: [] as number[] }, collapsed: { count: 0, savingsPct: [] as number[] } };
  const usage = records.filter((record: any) => record && typeof record === 'object' &&
    (record.handler === 'search_skill_sections' || record.handler === 'resolve_task_sections')) as any[];
  const latencies = usage.map(record => record.latencyMs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = (p: number): number => latencies.length === 0 ? 0 : latencies[Math.ceil(p * latencies.length) - 1]!;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const r = record as any;
    if (r.handler === 'search_skill_sections' || r.handler === 'resolve_task_sections') {
      if (!r.tokenSavings && !r.collapsed && !r.multi) continue;
    }
    const savings = r.tokenSavings ?? r;
    const pct = typeof savings.savingsPct === 'number' ? savings.savingsPct : null;
    const bucket = r.collapsed ? distribution.collapsed : (r.multi ?? r.isMultiSection ? distribution.multi : distribution.single);
    bucket.count++;
    if (pct !== null && Number.isFinite(pct)) bucket.savingsPct.push(pct);
  }
  return JSON.stringify({
    indexedSections: sections.size,
    records: records.length,
    distribution,
    sessionCorrelation: 'approximate (process-local, 5min window)',
    usageSignals: {
      calls: usage.length,
      followUps: usage.filter(record => record.followUp === true).length,
      followUpRate: usage.length === 0 ? 0 : usage.filter(record => record.followUp === true).length / usage.length,
      latencyMs: {
        count: latencies.length,
        min: latencies.length === 0 ? 0 : latencies[0],
        max: latencies.length === 0 ? 0 : latencies.at(-1),
        mean: latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
        p50: percentile(0.5),
        p95: percentile(0.95)
      }
    }
  }, null, 2);
}

export function startWatch(deps: ToolDeps, system: string, path: string, delay = 50): { close: () => void; done: Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  let closed = false;
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      running = running.then(async () => {
        const index = await deps.store.readIndex();
        const sections = await deps.store.readSections(Object.keys(index));
        const stale = sections.size === 0 || [...sections.values()].some(section => {
          if (!section.sourcePath || !section.sourceHash) return true;
          const source = readSourceFile(section.sourcePath);
          const stat = statFile(section.sourcePath);
          return source === undefined || stat === null || computeHash(source) !== section.sourceHash;
        });
        if (stale) await handleIndexSkills(deps, system, [path], undefined, false);
      });
    }, delay);
  };
  const watcher = fsWatch(path, { recursive: true }, schedule);
  return { close: () => { closed = true; if (timer) clearTimeout(timer); watcher.close(); }, get done() { return running; } };
}

export async function runCli(argv = process.argv.slice(2), deps?: ToolDeps): Promise<number> {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { console.log(HELP); return 0; }
  const command = argv[0]!;
  const args = argv.slice(1);
  const toolDeps = deps ?? await createToolDeps({ ...(value(args, '--store') ? { storeDir: required(args, '--store') } : {}) });
  const emit = (text: string) => {
    if (!has(args, '--json')) return console.log(text);
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : value;
    console.log(JSON.stringify(sort(JSON.parse(text)), null, 2));
  };
  const call = async (name: string, input: unknown): Promise<string> => {
    const response = await handleMcpToolCall(toolDeps, name, input);
    return response.content[0].text;
  };
  try {
    if (command === 'index') emit(await call('index_skills', { system: value(args, '--system') ?? 'claude', ...(value(args, '--path') ? { roots: [required(args, '--path')] } : {}), ...(has(args, '--force') ? { force: true } : {}) }));
    else if (command === 'search') emit(await call('search_skill_sections', { query: positional(args)[0] ?? '', ...(value(args, '--phase') ? { phase: value(args, '--phase') } : {}), ...(value(args, '--skill') ? { skill: value(args, '--skill') } : {}), ...(value(args, '--k') ? { k: Number(value(args, '--k')) } : {}) }));
    else if (command === 'resolve') emit(await call('resolve_task_sections', { query: positional(args)[0] ?? '', ...(value(args, '--phase') ? { phase: value(args, '--phase') } : {}), ...(value(args, '--skill') ? { skill: value(args, '--skill') } : {}), ...(value(args, '--budget') ? { budget: Number(value(args, '--budget')) } : {}), ...(has(args, '--no-soft') ? { includeSoft: false } : {}) }));
    else if (command === 'get') {
      const ref = positional(args)[0] ?? '';
      const split = ref.indexOf('#');
      if (split >= 0) {
        const skill = ref.slice(0, split); const section = ref.slice(split + 1);
        const all = JSON.parse(await call('get_skill_sections', { skillId: skill }));
        const match = all.sections?.find((s: any) => s.id === section || s.id.endsWith(`::${section}`) || s.title === section);
        emit(await call('load_section', { sectionId: match?.id ?? `${skill}::${section}` }));
      } else emit(await call('get_skill_sections', { skillId: ref }));
    } else if (command === 'doctor') {
      const result = JSON.parse(await handleDoctor(toolDeps)) as { status: string };
      emit(JSON.stringify(result));
      return result.status === 'errors' ? 2 : result.status === 'warnings' ? 1 : 0;
    }
    else if (command === 'stats') console.log(await stats(toolDeps.store));
    else if (command === 'watch') {
      const path = resolvePath(value(args, '--path') ?? process.cwd());
      const watch = startWatch(toolDeps, value(args, '--system') ?? 'claude', path);
      await new Promise<void>(resolve => process.once('SIGINT', () => { watch.close(); resolve(); }));
    } else throw new Error(`unknown command: ${command}`);
    return 0;
  } catch (error) { console.error(JSON.stringify({ errors: [error instanceof Error ? error.message : String(error)] }, null, 2)); return 1; }
}

if (process.argv[1]?.endsWith('cli.js')) runCli().then(code => { process.exitCode = code; });
