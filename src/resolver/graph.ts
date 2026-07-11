// Graph operations for dependency resolution: transitive closure, topological sort,
// cycle detection, and cross-trust enforcement.

import type { SkillSection } from '../types.js';
import type { DanglingDep, TrustDemotion, ResolveWarning } from './types.js';

// ---------------------------------------------------------------------------
// Trust tier mapping
// ---------------------------------------------------------------------------

export function precedenceToTier(precedence: number | undefined): string {
  if (precedence === undefined) return 'unknown';
  if (precedence >= 200) return 'bundled';
  if (precedence >= 100) return 'project';
  if (precedence >= 50) return 'personal';
  if (precedence >= 10) return 'marketplace';
  return 'untrusted';
}

const TIER_ORDER: Record<string, number> = {
  bundled: 5,
  project: 4,
  personal: 3,
  marketplace: 2,
  untrusted: 1,
  unknown: 0,
};

// ---------------------------------------------------------------------------
// Cross-trust check
// ---------------------------------------------------------------------------

// Returns true if the source's trust tier is lower than the target's
// (e.g. untrusted requires project → blocked).
// Higher→lower is allowed (source is trusted, target is not).
export function isLowerToHigherTier(sourcePrecedence: number | undefined, targetPrecedence: number | undefined): boolean {
  const sourceTier = TIER_ORDER[precedenceToTier(sourcePrecedence)] ?? 0;
  const targetTier = TIER_ORDER[precedenceToTier(targetPrecedence)] ?? 0;
  return sourceTier < targetTier;
}

// ---------------------------------------------------------------------------
// Cycle detection via DFS
// Returns the strongly connected components (cycles) in the dependency graph.
// ---------------------------------------------------------------------------

export interface CycleGroup {
  nodeIds: string[];
}

function localSlug(section: SkillSection, id: string): string {
  return id.split('::').pop()!.toLowerCase();
}

export function resolveRequiredId(
  section: SkillSection,
  requiredId: string,
  sectionMap: Map<string, SkillSection>
): string {
  if (sectionMap.has(requiredId)) return requiredId;

  const slug = requiredId.split('::').pop()!.toLowerCase();
  const manifestId = section.manifestId;
  if (manifestId) {
    const target = [...sectionMap.values()].find(s =>
      s.manifestId === manifestId && localSlug(s, s.id) === slug
    );
    if (target) return target.id;
  }

  const skillPrefix = section.id.split('::').slice(0, -1).join('::');
  const target = sectionMap.get(`${skillPrefix}::${slug}`);
  return target?.id ?? requiredId;
}

export function detectCycles(
  sectionMap: Map<string, SkillSection>,
  getRequiredIds: (section: SkillSection) => string[]
): CycleGroup[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const cycles: CycleGroup[] = [];
  const onCycle = new Set<string>();

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    inStack.add(nodeId);
    stack.push(nodeId);

    const section = sectionMap.get(nodeId);
    if (section) {
      for (const rawReqId of getRequiredIds(section)) {
        const reqId = resolveRequiredId(section, rawReqId, sectionMap);
        if (!visited.has(reqId)) {
          dfs(reqId);
        } else if (inStack.has(reqId)) {
          // Found a cycle — extract nodes from stack
          const cycleStart = stack.indexOf(reqId);
          const cycleNodes = stack.slice(cycleStart);
          for (const n of cycleNodes) onCycle.add(n);
          cycles.push({ nodeIds: [...cycleNodes] });
        }
      }
    }

    stack.pop();
    inStack.delete(nodeId);
  }

  for (const [nodeId] of sectionMap) {
    if (!visited.has(nodeId)) {
      dfs(nodeId);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Transitive closure of requires edges with cross-trust enforcement
// ---------------------------------------------------------------------------

export interface ClosureResult {
  hardIds: Set<string>;              // IDs that must be included (hard)
  demotedIds: Set<string>;           // IDs that were demoted from requires to related due to cross-trust
  envelopedIds: Set<string>;         // IDs reached through an allowed higher→lower trust edge
  warnings: ResolveWarning[];
}

export function transitiveClosure(
  seeds: SkillSection[],
  sectionMap: Map<string, SkillSection>,
  getRequiredIds: (section: SkillSection) => string[]
): ClosureResult {
  const hardIds = new Set<string>();
  const demotedIds = new Set<string>();
  const envelopedIds = new Set<string>();
  const visited = new Set<string>();
  const warnings: ResolveWarning[] = [];

  function walk(section: SkillSection): void {
    if (visited.has(section.id)) return;
    visited.add(section.id);
    hardIds.add(section.id);

    for (const rawReqId of getRequiredIds(section)) {
      const reqId = resolveRequiredId(section, rawReqId, sectionMap);
      const target = sectionMap.get(reqId);

      if (!target) {
        // Dangling dependency — flag and skip (floor invariant: don't crash)
        warnings.push({
          type: 'dangling_requires',
          sourceSection: section.id,
          targetId: reqId,
          reason: `target section "${reqId}" not found in index`,
        } satisfies DanglingDep);
        continue;
      }

      // Cross-trust check (lower→higher blocked at resolve time)
      if (isLowerToHigherTier(section.precedence, target.precedence)) {
        demotedIds.add(target.id);
        warnings.push({
          type: 'trust_demotion',
          sourceSection: section.id,
          targetId: target.id,
          fromTier: precedenceToTier(target.precedence),
          toTier: precedenceToTier(section.precedence),
          direction: 'lower_to_higher',
        } satisfies TrustDemotion);
        continue; // demoted: don't add to hard closure, don't walk into it
      }

      // Higher→lower trust: allow but the target inherits the lower tier
      if (isLowerToHigherTier(target.precedence, section.precedence)) {
        // This is higher→lower, which is allowed, but the content must be
        // treated as an untrusted reference at assembly time.
        envelopedIds.add(target.id);
      }

      if (!visited.has(target.id)) {
        walk(target);
      }
    }
  }

  for (const seed of seeds) {
    walk(seed);
  }

  return { hardIds, demotedIds, envelopedIds, warnings };
}

// ---------------------------------------------------------------------------
// Topological sort with cycle-aware grouping
// ---------------------------------------------------------------------------

export interface TopoGroup {
  ids: string[];         // single section or co-required group
  isCycle: boolean;      // true if this group is a cycle (no strict internal order)
}

export function topologicalSort(
  seedIds: Set<string>,
  hardIds: Set<string>,
  sectionMap: Map<string, SkillSection>,
  getRequiredIds: (section: SkillSection) => string[],
  cycles: CycleGroup[]
): TopoGroup[] {
  // Build adjacency list from hardIds only, excluding cycle-internal edges
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of hardIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }

  const cycleNodeSet = new Set(cycles.flatMap(c => c.nodeIds));

  for (const id of hardIds) {
    const section = sectionMap.get(id);
    if (!section) continue;
    for (const rawReqId of getRequiredIds(section)) {
      const reqId = resolveRequiredId(section, rawReqId, sectionMap);
      if (!hardIds.has(reqId)) continue;
      // Skip cycle-internal edges: if both source and target are in the same cycle,
      // don't add the edge (the group has no strict internal order)
      const parentCycle = cycles.find(c => c.nodeIds.includes(id) && c.nodeIds.includes(reqId));
      if (parentCycle) continue;
       adj.get(reqId)!.push(id);
       inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  // Prioritize seed sections and their dependencies first
  // A simple approach: add seed-related IDs early
  const ordered: TopoGroup[] = [];
  const placed = new Set<string>();

  while (queue.length > 0) {
    // Sort by seed proximity: sections with no incoming edges that are closer to seeds go first
    queue.sort((a, b) => {
      const aInSeed = seedIds.has(a) ? -1 : 0;
      const bInSeed = seedIds.has(b) ? -1 : 0;
      return bInSeed - aInSeed;
    });

    const id = queue.shift()!;
    if (placed.has(id)) continue;
    placed.add(id);

    // Check if this node is part of a cycle
    const containingCycle = cycles.find(c => c.nodeIds.includes(id));
    if (containingCycle && !placed.has(containingCycle.nodeIds[0]!)) {
      // Place the entire cycle as one group
      const cycleGroup: TopoGroup = {
        ids: [...containingCycle.nodeIds],
        isCycle: true,
      };
      ordered.push(cycleGroup);
      for (const nid of containingCycle.nodeIds) placed.add(nid);
      // Process cycle node's outgoing edges
      for (const nid of containingCycle.nodeIds) {
        for (const neighbor of adj.get(nid) ?? []) {
          if (!placed.has(neighbor)) {
            inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1);
            if (inDegree.get(neighbor) === 0) queue.push(neighbor);
          }
        }
      }
    } else {
      ordered.push({ ids: [id], isCycle: false });
      for (const neighbor of adj.get(id) ?? []) {
        if (!placed.has(neighbor)) {
          inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1);
          if (inDegree.get(neighbor) === 0) queue.push(neighbor);
        }
      }
    }
  }

  // Resolve cycles after acyclic prerequisites have been placed.
  for (const cycle of cycles) {
    const ids = cycle.nodeIds.filter(id => hardIds.has(id) && !placed.has(id));
    if (ids.length === 0) continue;
    ordered.push({ ids, isCycle: true });
    for (const id of ids) placed.add(id);
  }

  // Add any remaining hardIds that weren't reached (shouldn't happen, but safety)
  for (const id of hardIds) {
    if (!placed.has(id)) {
      ordered.push({ ids: [id], isCycle: false });
      placed.add(id);
    }
  }

  return ordered;
}
