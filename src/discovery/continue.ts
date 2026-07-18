import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ArtifactKind, DiscoveredArtifact, DiscoveryContext, DiscoveryDiagnostic } from '../types.js';
import { collectAllowedRoots, isPathSafe } from '../fs/roots.js';
import { createScanBudget, EXPLICIT_ROOT_GUIDANCE, scanFile, scanMarkdownRoot, scannerLimits, type ScanBudget, type ScanSafetyCallback } from './shared.js';
const MAX_CONFIG_REFERENCES = 100;
type ContinueDiagnosticCallback = (diagnostic: DiscoveryDiagnostic) => void;

export function discoverContinue(
  ctx: DiscoveryContext,
  onScan?: ScanSafetyCallback,
  onDiagnostic?: ContinueDiagnosticCallback,
  budget: ScanBudget = createScanBudget()
): DiscoveredArtifact[] {
  const allowedRoots = collectAllowedRoots(ctx);
  const projectRoots = [ctx.repoRoot, ctx.workspaceRoot].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
  const rootArtifacts = projectRoots.flatMap(root =>
    scanMarkdownRoot(join(root, '.continue', 'rules'), allowedRoots, ctx, 'continue', '.md', 'rule_file', 4, onScan, budget)
  );
  const results = [...rootArtifacts];

  if (rootArtifacts.length === 0) {
    onDiagnostic?.(diagnostic('roots', 'roots', 'unavailable', 'SOURCE_ABSENT', 0, 0, 'No supported Continue workspace rule root was present.'));
  }

  if (ctx.includeGlobals) {
    const config = readActiveConfig(ctx.homeDir, allowedRoots);
    if (config.state === 'absent') {
      onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_ABSENT', 0, 0, 'No stable readable Continue user configuration was present.'));
    } else if (config.state === 'invalid') {
      onDiagnostic?.(diagnostic('configuration', 'configuration', 'skipped', 'SOURCE_INVALID', 0, 1, 'The active Continue user configuration was malformed, unsupported, or unsafe and was skipped.'));
    } else if (config.state === 'used') {
      let skipped = config.skipped;
      for (const reference of config.references) {
        if (budget.exhausted) break;
        const before = results.length;
        const reports: Parameters<ScanSafetyCallback>[0][] = [];
        results.push(...scanFile(reference.path, dirname(reference.path), allowedRoots, ctx, 'continue', reference.kind, config.rootOrigin, report => { reports.push(report); onScan?.(report); }, budget));
        if (results.length === before) skipped += Math.max(1, reports.reduce((total, report) => total + report.skippedCount, 0));
      }
      onDiagnostic?.(diagnostic(
        'configuration', 'configuration',
        skipped > 0 ? 'limited' : 'used', skipped > 0 ? 'SOURCE_INVALID' : 'SOURCE_USED',
        results.length - rootArtifacts.length, skipped,
        skipped > 0
          ? 'Only bounded local Markdown file references from the active Continue config were used; inline, remote, malformed, or unsafe entries were skipped.'
          : 'Bounded local Markdown rule and prompt references from the active Continue user config were used.'
      ));
    }
  } else {
    onDiagnostic?.(diagnostic('configuration', 'configuration', 'unavailable', 'SOURCE_ABSENT', 0, 0, 'Continue user configuration discovery was not enabled.'));
  }

  onDiagnostic?.(diagnostic(
    'configuration', 'configuration', 'unavailable', 'SOURCE_UNSUPPORTED', 0, 0,
    'Composed system messages, toolbar selection, remote Hub blocks, inline config text, private state, and runtime activation are unsupported.'
  ));
  return results;
}

type ConfigReference = { path: string; kind: ArtifactKind };
type ConfigResult =
  | { state: 'absent' | 'invalid' }
  | { state: 'used'; references: ConfigReference[]; skipped: number; rootOrigin: string };

function readActiveConfig(homeDir: string, allowedRoots: string[]): ConfigResult {
  const rootOrigin = join(homeDir, '.continue');
  const yamlPath = join(rootOrigin, 'config.yaml');
  const jsonPath = join(rootOrigin, 'config.json');
  const path = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : null;
  if (!path) return { state: 'absent' };
  try {
    if (Buffer.byteLength(path, 'utf8') > scannerLimits.pathBytes || lstatSync(path).isSymbolicLink() || !isPathSafe(path, allowedRoots)) return { state: 'invalid' };
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > scannerLimits.fileBytes) return { state: 'invalid' };
    const raw = readFileSync(path, 'utf8');
    const parsed = extname(path) === '.json'
      ? JSON.parse(raw)
      : YAML.parse(raw, { schema: 'core', customTags: [], maxAliasCount: 100 });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid' };
    const config = parsed as Record<string, unknown>;
    if (path === yamlPath && config.schema !== 'v1') return { state: 'invalid' };
    const references: ConfigReference[] = [];
    let skipped = 0;
    let inspected = 0;
    let stopped = false;
    for (const [key, kind] of [['rules', 'rule_file'], ['prompts', 'instruction_file']] as const) {
      const entries = config[key];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) { skipped++; continue; }
      for (const entry of entries) {
        if (inspected++ >= scannerLimits.entries || references.length >= MAX_CONFIG_REFERENCES) { skipped++; stopped = true; break; }
        const uses = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as Record<string, unknown>).uses : null;
        if (typeof uses !== 'string' || !uses.startsWith('file://')) { skipped++; continue; }
        try {
          const localPath = fileURLToPath(uses);
          if (!['.md', '.markdown'].includes(extname(localPath).toLowerCase())) { skipped++; continue; }
          references.push({ path: localPath, kind });
        } catch { skipped++; }
      }
      if (stopped) break;
    }
    return { state: 'used', references, skipped, rootOrigin };
  } catch {
    return { state: 'invalid' };
  }
}

function diagnostic(
  capability: DiscoveryDiagnostic['capability'], sourceType: DiscoveryDiagnostic['sourceType'], status: DiscoveryDiagnostic['status'],
  code: DiscoveryDiagnostic['code'], foundCount: number, skippedCount: number, limitation: string
): DiscoveryDiagnostic {
  return {
    environment: 'continue', capability, sourceType, status, code,
    foundCount: Math.min(foundCount, scannerLimits.results),
    skippedCount: Math.min(skippedCount, scannerLimits.entries),
    limitation, explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
  };
}
