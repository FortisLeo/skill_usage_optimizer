import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { ArtifactKind, DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scannerLimits, type ScanBudget, type ScanSafetyResult } from './shared.js';
const MAX_CONFIG_REFERENCES = 100;
type AiderDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

type ConfigResult =
  | { state: 'absent' }
  | { state: 'invalid' | 'unsafe' }
  | { state: 'used'; hasRead: boolean; references: string[]; skipped: number; truncated: boolean; rootOrigin: string };

export function discoverAider(
  ctx: DiscoveryContext,
  onScan?: (report: ScanSafetyResult) => void,
  onDiagnostic?: AiderDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const allowedRoots = collectAllowedRoots(ctx);
  const configRoots = [
    ...(ctx.includeGlobals ? [ctx.homeDir] : []),
    ...[ctx.repoRoot, ctx.workspaceRoot].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index)
  ];
  const configs = configRoots.map(root => readConfig(join(root, '.aider.conf.yml'), root, allowedRoots));
  const usable = configs.filter((config): config is Extract<ConfigResult, { state: 'used' }> => config.state === 'used');
  const active = [...usable].reverse().find(config => config.hasRead);

  for (const config of configs) {
    if (config.state === 'invalid') onDiagnostic?.(diagnostic('configuration', 'configuration', 'skipped', 'SOURCE_INVALID', 0, 1, 'A supported Aider config was malformed or exceeded fixed safety limits and was skipped.'));
    if (config.state === 'unsafe') onDiagnostic?.(diagnostic('configuration', 'configuration', 'skipped', 'SOURCE_UNSAFE', 0, 1, 'An unsafe Aider config path was skipped.'));
  }

  const references = active?.references.map(path => ({ path, rootOrigin: active.rootOrigin })) ?? [];
  let skipped = active?.skipped ?? 0;
  const truncated = active?.truncated ?? false;

  const artifacts: DiscoveredArtifact[] = [];
  const reportCounts = new Map<DiscoveryDiagnostic['code'], number>();
  for (const reference of references) {
    if (budget.exhausted) break;
    const absolutePath = resolveReference(reference.path, ctx);
    if (!absolutePath) {
      skipped++;
      reportCounts.set('SOURCE_INVALID', (reportCounts.get('SOURCE_INVALID') ?? 0) + 1);
      continue;
    }
    const reports: ScanSafetyResult[] = [];
    const found = scanFile(
      absolutePath, dirname(absolutePath), allowedRoots, ctx, 'aider', classify(reference.path), reference.rootOrigin,
      report => { reports.push(report); onScan?.(report); }, budget
    );
    artifacts.push(...found);
    if (found.length > 0) continue;
    skipped++;
    const code = reportCode(reports, absolutePath);
    reportCounts.set(code, (reportCounts.get(code) ?? 0) + 1);
  }

  if (configs.every(config => config.state === 'absent')) {
    onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_ABSENT', 0, 0, 'No supported Aider configuration file was present.'));
  } else if (!active || references.length === 0) {
    onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_ABSENT', 0, skipped, 'No supported read entries were present in readable Aider configuration.'));
  }
  if (artifacts.length > 0 || skipped > 0) {
    onDiagnostic?.(diagnostic(
      'configuration', 'configuration', skipped > 0 ? 'limited' : 'used', skipped > 0 ? 'SOURCE_INVALID' : 'SOURCE_USED',
      artifacts.length, skipped,
      skipped > 0 ? 'Only bounded safe files explicitly listed by Aider read configuration were used; invalid references were skipped.' : 'Bounded safe files explicitly listed by Aider read configuration were used.'
    ));
  }
  for (const [code, count] of reportCounts) {
    onDiagnostic?.(diagnostic('configuration', 'configuration', 'skipped', code, 0, count, limitationFor(code)));
  }
  if (truncated) onDiagnostic?.(diagnostic('configuration', 'configuration', 'truncated', 'SOURCE_TRUNCATED', artifacts.length, skipped, 'Aider read configuration reached the fixed 100-reference limit; remaining entries were skipped.'));
  onDiagnostic?.(diagnostic('roots', 'roots', 'unavailable', 'SOURCE_UNSUPPORTED', 0, 0, 'Aider has no native skills directory; unconfigured convention files are not inferred.'));
  onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_UNSUPPORTED', 0, 0, 'Session /read state, CLI arguments, alternate --config files, runtime context, and final prompts are unavailable.'));
  return artifacts;
}

function readConfig(path: string, rootOrigin: string, allowedRoots: string[]): ConfigResult {
  if (!existsSync(path)) return { state: 'absent' };
  try {
    if (Buffer.byteLength(path, 'utf8') > scannerLimits.pathBytes || lstatSync(path).isSymbolicLink() || !isPathSafe(path, [rootOrigin]) || !isPathSafe(path, allowedRoots)) return { state: 'unsafe' };
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > scannerLimits.fileBytes) return { state: 'invalid' };
    const parsed = YAML.parse(readFileSync(path, 'utf8'), { schema: 'core', customTags: [], maxAliasCount: 100 });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid' };
    const read = (parsed as Record<string, unknown>).read;
    if (read === undefined) return { state: 'used', hasRead: false, references: [], skipped: 0, truncated: false, rootOrigin };
    const entries = typeof read === 'string' ? [read] : Array.isArray(read) ? read : null;
    if (!entries) return { state: 'used', hasRead: true, references: [], skipped: 1, truncated: false, rootOrigin };
    const references: string[] = [];
    let skipped = 0;
    let truncated = false;
    for (let index = 0; index < entries.length; index++) {
      if (index === MAX_CONFIG_REFERENCES) {
        skipped = Math.min(skipped + 1, MAX_CONFIG_REFERENCES);
        truncated = true;
        break;
      }
      const entry = entries[index];
      if (typeof entry !== 'string' || entry.trim().length === 0) { skipped = Math.min(skipped + 1, MAX_CONFIG_REFERENCES); continue; }
      references.push(entry);
    }
    return { state: 'used', hasRead: true, references, skipped, truncated, rootOrigin };
  } catch {
    return { state: 'invalid' };
  }
}

function resolveReference(reference: string, ctx: DiscoveryContext): string | null {
  if (reference.includes('\0') || Buffer.byteLength(reference, 'utf8') > scannerLimits.pathBytes) return null;
  if (reference === '~') return ctx.homeDir;
  if (reference.startsWith('~/') || reference.startsWith('~\\')) return resolve(ctx.homeDir, reference.slice(2));
  return isAbsolute(reference) ? resolve(reference) : resolve(ctx.workspaceRoot, reference);
}

function classify(path: string): ArtifactKind {
  return /(?:convention|style)/i.test(basename(path)) ? 'convention_file' : 'instruction_file';
}

function reportCode(reports: ScanSafetyResult[], path: string): DiscoveryDiagnostic['code'] {
  const reasons = new Set(reports.flatMap(report => report.reasons));
  if (reports.some(report => report.truncated)) return 'SOURCE_TRUNCATED';
  if ([...reasons].some(reason => ['file_size', 'path_length', 'symlink', 'unsafe'].includes(reason))) return 'SOURCE_UNSAFE';
  if (reasons.has('inaccessible')) return 'SOURCE_INACCESSIBLE';
  return existsSync(path) ? 'SOURCE_INVALID' : 'SOURCE_ABSENT';
}

function limitationFor(code: DiscoveryDiagnostic['code']): string {
  if (code === 'SOURCE_UNSAFE') return 'Unsafe, oversized, overlong, or symlinked Aider read references were skipped.';
  if (code === 'SOURCE_INACCESSIBLE') return 'Inaccessible Aider read references were skipped.';
  if (code === 'SOURCE_TRUNCATED') return 'Aider read discovery reached a fixed safety limit; remaining entries were skipped.';
  if (code === 'SOURCE_ABSENT') return 'Missing Aider read references were skipped.';
  return 'Malformed or unsupported Aider read references were skipped.';
}

function diagnostic(
  capability: DiscoveryDiagnostic['capability'], sourceType: DiscoveryDiagnostic['sourceType'], status: DiscoveryDiagnostic['status'],
  code: DiscoveryDiagnostic['code'], foundCount: number, skippedCount: number, limitation: string
): DiscoveryDiagnostic {
  return {
    environment: 'aider', capability, sourceType, status, code,
    foundCount: Math.min(foundCount, scannerLimits.results),
    skippedCount: Math.min(skippedCount, scannerLimits.entries),
    limitation, explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  };
}
