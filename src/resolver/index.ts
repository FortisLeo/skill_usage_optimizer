// Resolver: main entry point. Implements §3.3 algorithm.

import type { SkillSection, SkillStore, ResolveRequest, ResolveResult, ResolvedSection } from '../types.js';
import { searchSections } from '../search/lexical.js';
import { transitiveClosure, detectCycles, topologicalSort, precedenceToTier } from './graph.js';
import { mergeInferredEdges } from './edges.js';
import { shouldCollapse, createBudget, sectionTokens, fitsInBudget, deductBudget, defaultBudget } from './budget.js';
import { isFlow, expandFlow } from './flows.js';

const SOFT_THRESHOLD = 0.3;

function values(store: SkillStore | SkillSection[]): SkillSection[] {
  if (Array.isArray(store)) return store;
  return store instanceof Map ? [...store.values()] : Object.values(store);
}

function sectionMap(store: SkillStore | SkillSection[]): Map<string, SkillSection> {
  const arr = values(store);
  const map = new Map<string, SkillSection>();
  for (const s of arr) map.set(s.id, s);
  return map;
}

function getRelatedEdges(section: SkillSection): { id: string; weight: number; source: string }[] {
  return (section.related ?? []).map(r => ({ id: r.id, weight: r.weight, source: r.source }));
}

// Convert a flat section list to ResolvedSection format
function toResolved(section: SkillSection, role: 'hard' | 'soft', order: number, enveloped = false): ResolvedSection {
  return {
    id: section.id,
    headingPath: section.title ? [section.title] : [],
    content: enveloped ? `[untrusted reference — verify before acting]\n${section.content}` : section.content,
    role,
    order,
    trustTier: precedenceToTier(section.precedence),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function resolve(
  store: SkillStore | SkillSection[],
  request: ResolveRequest
): ResolveResult {
  const allSections = values(store);
  const sMap = sectionMap(store);
  const resolvedEdges = new Map(
    allSections.map(section => [section.id, mergeInferredEdges(section, allSections)])
  );
  const getRequiredIds = (section: SkillSection): string[] => [
    ...(resolvedEdges.get(section.id)?.requires ?? []),
  ];
  const budget = defaultBudget();
  const actualBudget = request.budget ?? budget.limit;

  // 1. Search for seed sections
  const workflow = /\b(?:and|then|after|before)\b/i.test(request.query);
  const seedLimit = request.k ?? 1;
  const searchStore = request.skill
    ? allSections.filter(s => s.manifestId?.includes(`::${request.skill}::`))
    : store;
  const ordinarySeeds = searchSections(searchStore, request.query).slice(0, seedLimit);
  let seeds: SkillSection[] = ordinarySeeds;
  if (workflow) {
    const clauses = request.query.split(/\b(?:and|then|after|before)\b/i).map(c => c.trim()).filter(Boolean);
    const seen = new Set<string>();
    seeds = [];
    for (const clause of clauses) {
      const lexicalClause = clause
        .replace(/\bset\s+up\b/gi, 'setup')
        .replace(/\bmigration\b/gi, 'migrations');
      const match = searchSections(searchStore, lexicalClause)[0];
      const seed = match ?? ordinarySeeds[0];
      if (seed && !seen.has(seed.id)) {
        seen.add(seed.id);
        seeds.push(seed);
      }
    }
  }

  if (seeds.length === 0) {
    return {
      query: request.query,
      seed: '',
      collapsed: false,
      sections: [],
      leftovers: [],
      budget: { limit: actualBudget, used: 0 },
    };
  }

  const seed = seeds[0]!;

  // 2. Check for flow match
  if (isFlow(request.query, allSections)) {
    const flowSections = expandFlow(request.query, allSections);
    const resolved = flowSections.map((s, i) => toResolved(s, 'hard', i));
    return {
      query: request.query,
      seed: seed.id,
      matchedFlow: request.query,
      collapsed: false,
      sections: resolved,
      leftovers: [],
      budget: { limit: actualBudget, used: resolved.reduce((sum, s) => sum + s.content.length, 0) },
    };
  }

  // 3. Compute hard closure with cross-trust enforcement
  //    Cross-trust check happens inside transitiveClosure() in graph.ts:
  //    when a requires edge points lower→higher trust, the target is
  //    moved to demotedIds instead of hardIds (see line ~75 in graph.ts).
  const closure = transitiveClosure(seeds, sMap, getRequiredIds);

  // 4. Get the skill's full section set for collapse check
  const seedSkillId = seed.manifestId;
  const skillSections = seedSkillId
    ? allSections.filter(s => s.manifestId === seedSkillId)
    : [seed];

  // 5. Detect cycles among hard dependencies
  const cycles = detectCycles(sMap, getRequiredIds);
  // Filter cycles to only include those touching our hard closure
  const relevantCycles = cycles.filter(c =>
    [...closure.hardIds].some(hid => c.nodeIds.includes(hid))
  );

  // 6. Topological sort with cycle-aware grouping
  const seedIds = new Set(seeds.map(s => s.id));
  const topoGroups = topologicalSort(seedIds, closure.hardIds, sMap, getRequiredIds, relevantCycles);

  // 7. Build ordered hard section list
  const hardSections: SkillSection[] = [];
  for (const group of topoGroups) {
    for (const id of group.ids) {
      const s = sMap.get(id);
      if (s) hardSections.push(s);
    }
  }

  // 8. Collapse valve
  if (shouldCollapse(hardSections, skillSections, budget.collapseRatio)) {
    const allResolved = skillSections.map((s, i) => toResolved(s, 'hard', i, closure.envelopedIds.has(s.id)));
    return {
      query: request.query,
      seed: seed.id,
      collapsed: true,
      sections: allResolved,
      leftovers: [],
      budget: {
        limit: actualBudget,
        used: allResolved.reduce((sum, s) => sum + s.content.length, 0),
      },
    };
  }

  // 9. Soft expansion (budgeted + thresholded)
  const budgetState = createBudget(actualBudget);
  let order = 0;
  const resolvedSections: ResolvedSection[] = [];
  const leftovers: string[] = [];

  // Deduct hard sections from budget
  for (const s of hardSections) {
    resolvedSections.push(toResolved(s, 'hard', order++, closure.envelopedIds.has(s.id)));
    // Only deduct if not mandatory (always sections)
    if (s.class !== 'always' && !s.policy?.alwaysInclude) {
      const newBudget = deductBudget(budgetState, s);
      budgetState.remaining = newBudget.remaining;
      budgetState.used = newBudget.used;
    }
  }

  // Collect soft candidates from related edges of all hard sections + inferred edges
  const softCandidates: { section: SkillSection; score: number }[] = [];
  const seenSoft = new Set<string>();

  for (const s of hardSections) {
    // Author-declared related
    for (const r of getRelatedEdges(s)) {
      if (seenSoft.has(r.id)) continue;
      seenSoft.add(r.id);
      const target = sMap.get(r.id);
      if (target && !closure.hardIds.has(target.id)) {
        softCandidates.push({ section: target, score: r.weight });
      }
    }
    // Inferred edges (uses provides/uses from P1)
    const inferred = resolvedEdges.get(s.id)!;
    for (const r of inferred.related) {
      if (seenSoft.has(r.id)) continue;
      seenSoft.add(r.id);
      const target = sMap.get(r.id);
      if (target && !closure.hardIds.has(target.id)) {
        softCandidates.push({ section: target, score: r.weight });
      }
    }
    // Also include demoted (cross-trust blocked) sections as soft candidates
    for (const demotedId of closure.demotedIds) {
      if (seenSoft.has(demotedId)) continue;
      seenSoft.add(demotedId);
      const target = sMap.get(demotedId);
      if (target && !closure.hardIds.has(target.id)) {
        // Demoted edges get a low default score so they're last in line
        softCandidates.push({ section: target, score: 0.2 });
      }
    }
  }

  // Filter by threshold and sort by score descending
  const eligible = softCandidates
    .filter(c => c.score >= SOFT_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  // Greedily take soft sections while budget allows
  const includeSoft = request.includeSoft ?? true;
  if (includeSoft) {
    for (const candidate of eligible) {
      if (fitsInBudget(budgetState, candidate.section)) {
        resolvedSections.push(toResolved(candidate.section, 'soft', order++));
        const newBudget = deductBudget(budgetState, candidate.section);
        budgetState.remaining = newBudget.remaining;
        budgetState.used = newBudget.used;
      } else {
        leftovers.push(candidate.section.id);
      }
    }
  } else {
    // When soft is disabled, all eligible soft sections become leftovers
    for (const candidate of eligible) {
      leftovers.push(candidate.section.id);
    }
  }

  // 10. Assemble
  return {
    query: request.query,
    seed: seed.id,
    collapsed: false,
    sections: resolvedSections,
    leftovers,
    budget: { limit: actualBudget, used: budgetState.used },
  };
}
