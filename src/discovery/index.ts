import { SOURCE_SYSTEMS, type DiscoveredArtifact, type DiscoveryDiagnostic, type DiscoverResult, type DiscoveryContext, type SourceSystem } from '../types.js';
import { collectAllowedRoots, resolveRealpath } from '../fs/roots.js';
import { discoverClaude } from './claude.js';
import { discoverOpencode } from './opencode.js';
import { discoverCodex } from './codex.js';
import { discoverCopilot } from './copilot.js';
import { discoverCursor } from './cursor.js';
import { discoverGemini } from './gemini.js';
import { discoverWindsurf } from './windsurf.js';
import { discoverCline } from './cline.js';
import { discoverRoo } from './roo.js';
import { discoverContinue } from './continue.js';
import { discoverAider } from './aider.js';
import { EXPLICIT_ROOT_GUIDANCE, scanExplicitRoots, scannerLimits } from './shared.js';
import type { ScanSafetyCallback, ScanSafetyResult } from './shared.js';

const SYSTEM_ORDER = Object.fromEntries(SOURCE_SYSTEMS.map((system, index) => [system, index])) as Record<SourceSystem, number>;
const MAX_DIAGNOSTICS = 100;

const DISCOVERERS: [SourceSystem, (ctx: DiscoveryContext, onScan?: ScanSafetyCallback, onDiagnostic?: (diagnostic: DiscoveryDiagnostic) => void) => DiscoveredArtifact[]][] = [
  ['claude', discoverClaude],
  ['opencode', discoverOpencode],
  ['codex', discoverCodex],
  ['copilot', discoverCopilot],
  ['cursor', discoverCursor],
  ['gemini', discoverGemini],
  ['windsurf', discoverWindsurf],
  ['cline', discoverCline],
  ['roo', discoverRoo],
  ['continue', discoverContinue],
  ['aider', discoverAider]
];

export function discover(ctx: DiscoveryContext, onScan?: ScanSafetyCallback): DiscoverResult {
  try {
    const all: DiscoveredArtifact[] = [];
    const errors: { path: string; error: string }[] = [];
    const discoveryDiagnostics: DiscoveryDiagnostic[] = [];

    const recordScan = (sourceType: DiscoveryDiagnostic['sourceType']) => (report: ScanSafetyResult): void => {
      onScan?.(report);
      if (report.foundCount === 0 && report.skippedCount === 0) return;
      addDiagnostic(discoveryDiagnostics, scanDiagnostic(report, sourceType));
    };

  for (const [system, fn] of DISCOVERERS) {
    if (ctx.requestedSystem && system !== ctx.requestedSystem) continue;
    try {
      all.push(...fn(ctx, recordScan('roots'), diagnostic => addDiagnostic(discoveryDiagnostics, diagnostic)));
    } catch {
      if (ctx.requestedSystem === system) {
        errors.push({ path: `discover:${system}`, error: 'Requested source adapter failed.' });
        continue;
      }
      addDiagnostic(discoveryDiagnostics, {
        environment: system,
        capability: 'roots',
        sourceType: 'roots',
        status: 'fallback',
        code: 'SOURCE_UNAVAILABLE',
        foundCount: 0,
        skippedCount: 0,
        limitation: 'Source adapter was unavailable; remaining roots were used.',
        explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
      });
    }
  }

  if (ctx.explicitRoots.length > 0) {
    const allowedRoots = collectAllowedRoots(ctx);
    try {
      const explicit = scanExplicitRoots(ctx.explicitRoots, allowedRoots, ctx, recordScan('explicit'));
      all.push(...explicit.artifacts);
      errors.push(...explicit.errors);
    } catch (err) {
      errors.push({
        path: 'discover:explicitRoots',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

    const deduped = dedupArtifacts(all);
    return {
      artifacts: sortArtifacts(deduped),
      errors,
      ...(discoveryDiagnostics.length > 0 ? { discoveryDiagnostics } : {})
    };
  } catch (err) {
    return { artifacts: [], errors: [{ path: 'discover', error: err instanceof Error ? err.message : String(err) }] };
  }
}

export function dedupArtifacts(artifacts: DiscoveredArtifact[]): DiscoveredArtifact[] {
  const map = new Map<string, DiscoveredArtifact>();
  for (const a of artifacts) {
    let canonicalPath = a.absolutePath;
    try { canonicalPath = resolveRealpath(a.absolutePath); } catch { /* scanner already rejects unsafe entries */ }
    const existing = map.get(canonicalPath);
    if (!existing || a.precedence > existing.precedence || (a.precedence === existing.precedence && SYSTEM_ORDER[a.system] < SYSTEM_ORDER[existing.system])) {
      map.set(canonicalPath, a);
    }
  }
  return [...map.values()];
}

function sortArtifacts(artifacts: DiscoveredArtifact[]): DiscoveredArtifact[] {
  const kindOrder: Record<string, number> = {
    skill_package: 0, instruction_file: 1, rule_file: 2, convention_file: 3, pseudo_skill: 4
  };

  return artifacts.sort((a, b) => {
    const sys = SYSTEM_ORDER[a.system] - SYSTEM_ORDER[b.system];
    if (sys !== 0) return sys;
    const k = (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
    if (k !== 0) return k;
    return a.relativePath.localeCompare(b.relativePath);
  });
}

function scanDiagnostic(report: ScanSafetyResult, sourceType: DiscoveryDiagnostic['sourceType']): DiscoveryDiagnostic {
  const unsafe = report.reasons.some(reason => ['file_size', 'path_length', 'symlink', 'unsafe'].includes(reason));
  const inaccessible = report.reasons.includes('inaccessible');
  const status = report.truncated ? 'truncated' : report.skippedCount > 0 ? 'limited' : 'used';
  const code = report.truncated ? 'SOURCE_TRUNCATED' : unsafe ? 'SOURCE_UNSAFE' : inaccessible ? 'SOURCE_INACCESSIBLE' : 'SOURCE_USED';
  const limitation = report.truncated
    ? 'Source scan reached a fixed safety limit; remaining entries were skipped.'
    : report.skippedCount > 0
      ? 'Unsafe, over-limit, or inaccessible entries were skipped.'
      : 'Source scan completed within fixed safety limits.';
  return {
    environment: report.system,
    capability: 'roots',
    sourceType,
    status,
    code,
    foundCount: Math.min(report.foundCount, scannerLimits.results),
    skippedCount: Math.min(report.skippedCount, scannerLimits.entries),
    limitation,
    explicitRootGuidance: report.skippedCount > 0 ? EXPLICIT_ROOT_GUIDANCE : ''
  };
}

function addDiagnostic(diagnostics: DiscoveryDiagnostic[], diagnostic: DiscoveryDiagnostic): void {
  const existing = diagnostics.find(item =>
    item.environment === diagnostic.environment && item.capability === diagnostic.capability &&
    item.sourceType === diagnostic.sourceType && item.status === diagnostic.status && item.code === diagnostic.code
  );
  if (existing) {
    existing.foundCount = Math.min(existing.foundCount + diagnostic.foundCount, scannerLimits.results);
    existing.skippedCount = Math.min(existing.skippedCount + diagnostic.skippedCount, scannerLimits.entries);
  } else if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic);
  }
}
