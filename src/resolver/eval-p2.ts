// P2 Eval runner — measures dependency recall on multi-section queries
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from '../resolver/index.js';
import { detectCycles, isLowerToHigherTier } from '../resolver/graph.js';
import type { ResolveRequest, SkillSection } from '../types.js';
import { expectedSection, loadEvalSections } from '../eval/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', 'tests', 'fixtures');
const EVAL_FILE = join(FIXTURES_DIR, 'eval', 'queries.json');

interface EvalEntry {
  query: string;
  skill: string;
  expectedSection: string;
  expectedSectionIds: string[];
  isMultiSection: boolean;
  notes: string;
}

function qualifyExpectedId(id: string, skill: string, skills: Record<string, SkillSection[]>): string {
  if (id.includes('::')) return id;
  return expectedSection(skills[skill] ?? [], id)?.id ?? id;
}

// Load and index all fixture skills
const skills = loadEvalSections(FIXTURES_DIR, ['well-structured', 'chrome-automation', 'database-ops', 'cycle-skill']);

// -----------------------------------------------------------------------
// Test 1: Cycle detection on cycle-skill
// -----------------------------------------------------------------------
console.log('=== P2 Eval: Cycle Detection ===\n');

const cycleSkill = skills['cycle-skill']!;
const cycleMap = new Map(cycleSkill.map(s => [s.id, s]));
const cycles = detectCycles(cycleMap, s => s.requires ?? []);
if (cycles.length > 0) {
  console.log(`✓ Cycle detected: ${cycles.length} cycle(s) found`);
  for (const c of cycles) {
    console.log(`  Cycle members: [${c.nodeIds.join(', ')}]`);
  }
} else {
  console.log('✗ No cycles detected (expected 1)');
}
console.log('');

// -----------------------------------------------------------------------
// Test 2: Dependency recall on multi-section queries
// -----------------------------------------------------------------------
console.log('=== P2 Eval: Dependency Recall on Multi-Section Queries ===\n');

const queries: EvalEntry[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));
const multiQueries = queries.filter(q => q.isMultiSection);

for (const q of multiQueries) {
  console.log(`Query: "${q.query}" (skill: ${q.skill})`);
  const expectedSectionIds = q.expectedSectionIds.map(id => qualifyExpectedId(id, q.skill, skills));
  console.log(`  Expected sections: [${q.expectedSectionIds.join(', ')}]`);

  const skillSections = skills[q.skill] ?? [];
  const request: ResolveRequest = {
    query: q.query,
    skill: q.skill,
    budget: 5000,
    includeSoft: true,
    k: 1,
  };
  const result = resolve(skillSections, request);

  console.log(`  Seed section: ${result.seed}`);
  console.log(`  Resolved sections (${result.sections.length}):`);
  let recall = 0;
  for (const s of result.sections) {
    const isExpected = expectedSectionIds.includes(s.id);
    if (isExpected) recall++;
    console.log(`    [${s.role}] ${s.id} ${isExpected ? '✓' : ''}`);
  }

   const recallScore = recall / expectedSectionIds.length;
   console.log(`  Recall: ${recall}/${expectedSectionIds.length} = ${(recallScore * 100).toFixed(0)}%`);

  // Check order: prerequisite should come first
  if (result.sections.length >= 2) {
    const firstId = result.sections[0]!.id;
    const secondId = result.sections[1]!.id;
     const firstIdx = expectedSectionIds.indexOf(firstId);
     const secondIdx = expectedSectionIds.indexOf(secondId);
    if (firstIdx >= 0 && secondIdx >= 0 && firstIdx < secondIdx) {
      console.log(`  Order check: ✓ "${firstId}" comes before "${secondId}" (prerequisite first)`);
    } else if (firstIdx >= 0 && secondIdx >= 0) {
       console.log(`  Order check: ⚠ expected "${expectedSectionIds[0]!}" first, but got "${firstId}"`);
    } else {
      console.log(`  Order check: ⚠ unable to compare "${firstId}" and "${secondId}" against expected sections`);
    }
  } else {
    console.log('  Order check: ⚠ fewer than two resolved sections');
  }

  console.log(`  Budget: ${result.budget.used}/${result.budget.limit}`);
  console.log(`  Collapsed: ${result.collapsed}`);
  console.log(`  Leftovers: [${result.leftovers.join(', ')}]`);
  console.log('');
}

// -----------------------------------------------------------------------
// Test 3: Cross-trust demotion (no real fixture exercises this yet, but verify
// the mechanism works with a synthetic scenario)
// -----------------------------------------------------------------------
console.log('=== P2 Eval: Cross-Trust Check (Mechanism Only) ===\n');

// Verify isLowerToHigherTier works correctly
console.log(`  untrusted(5) -> project(100): ${isLowerToHigherTier(5, 100) ? 'BLOCKED ✓' : 'ALLOWED ✗'}`);
console.log(`  project(100) -> untrusted(5): ${isLowerToHigherTier(100, 5) ? 'BLOCKED ✗' : 'ALLOWED ✓'}`);
console.log(`  project(100) -> project(100): ${isLowerToHigherTier(100, 100) ? 'BLOCKED ✗' : 'ALLOWED ✓'}`);
console.log('');

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------
console.log('=== Summary ===\n');

let allRecall = true;
for (const q of multiQueries) {
  const skillSections = skills[q.skill] ?? [];
  const result = resolve(skillSections, { query: q.query, skill: q.skill, budget: 5000, includeSoft: true, k: 1 });
  const expectedSectionIds = q.expectedSectionIds.map(id => qualifyExpectedId(id, q.skill, skills));
  const found = expectedSectionIds.filter(id => result.sections.some(s => s.id === id));
  const recallScore = found.length / q.expectedSectionIds.length;
  if (recallScore < 1.0) allRecall = false;
  console.log(`  "${q.query}": recall=${(recallScore * 100).toFixed(0)}% (${found.length}/${q.expectedSectionIds.length}) ${recallScore >= 1.0 ? '✓' : '✗'}`);
}

console.log(`\n  Dependency recall @1.0: ${allRecall ? 'PASS' : 'FAIL'}`);
console.log(`  Cycles detected: ${cycles.length > 0 ? `✓ (${cycles.length})` : '⚠ none'}`);
