import type { DiscoveredArtifact, DiscoverResult, DiscoveryContext } from '../types.js';
import { collectAllowedRoots } from '../fs/roots.js';
import { discoverClaude } from './claude.js';
import { discoverOpencode } from './opencode.js';
import { discoverCodex } from './codex.js';
import { discoverCopilot } from './copilot.js';
import { scanExplicitRoots } from './shared.js';

const DISCOVERERS: [string, (ctx: DiscoveryContext) => DiscoveredArtifact[]][] = [
  ['claude', discoverClaude],
  ['opencode', discoverOpencode],
  ['codex', discoverCodex],
  ['copilot', discoverCopilot]
];

export function discover(ctx: DiscoveryContext): DiscoverResult {
  try {
    const all: DiscoveredArtifact[] = [];
    const errors: { path: string; error: string }[] = [];

  for (const [system, fn] of DISCOVERERS) {
    try {
      all.push(...fn(ctx));
    } catch (err) {
      errors.push({
        path: `discover:${system}`,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (ctx.explicitRoots.length > 0) {
    const allowedRoots = collectAllowedRoots(ctx);
    try {
      const explicit = scanExplicitRoots(ctx.explicitRoots, allowedRoots, ctx);
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
    return { artifacts: sortArtifacts(deduped), errors };
  } catch (err) {
    return { artifacts: [], errors: [{ path: 'discover', error: err instanceof Error ? err.message : String(err) }] };
  }
}

function dedupArtifacts(artifacts: DiscoveredArtifact[]): DiscoveredArtifact[] {
  const map = new Map<string, DiscoveredArtifact>();
  for (const a of artifacts) {
    const existing = map.get(a.absolutePath);
    if (!existing || a.precedence > existing.precedence) {
      map.set(a.absolutePath, a);
    }
  }
  return [...map.values()];
}

function sortArtifacts(artifacts: DiscoveredArtifact[]): DiscoveredArtifact[] {
  const order: Record<string, number> = { claude: 0, opencode: 1, codex: 2, copilot: 3 };
  const kindOrder: Record<string, number> = {
    skill_package: 0, instruction_file: 1, rule_file: 2, convention_file: 3, pseudo_skill: 4
  };

  return artifacts.sort((a, b) => {
    const sys = (order[a.system] ?? 99) - (order[b.system] ?? 99);
    if (sys !== 0) return sys;
    const k = (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
    if (k !== 0) return k;
    return a.relativePath.localeCompare(b.relativePath);
  });
}
