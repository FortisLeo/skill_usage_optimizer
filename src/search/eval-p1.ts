// P1 Eval runner — measures precision@3 against tests/fixtures/eval/queries.json
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSections } from '../search/lexical.js';
import type { SkillSection } from '../types.js';
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

// Load and index all 3 fixture skills
const skills = loadEvalSections(FIXTURES_DIR, ['well-structured', 'chrome-automation', 'database-ops']);

// Build full store
const allSections: SkillSection[] = Object.values(skills).flat();

// Load eval queries
const queries: EvalEntry[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));

// Run eval
let correctTop1 = 0;
let correctTop3 = 0;
let total = 0;
let realCorrectTop3 = 0;
let realTotal = 0;
let syntheticCorrectTop3 = 0;
let syntheticTotal = 0;

const results: { query: string; skill: string; expected: string; top3: string[]; pass: boolean }[] = [];

for (const q of queries) {
  const skillSections = skills[q.skill];
  if (!skillSections) { console.error(`Unknown skill: ${q.skill}`); continue; }

  const top3 = searchSections(skillSections, q.query).slice(0, 3);
  const top3Ids = top3.map(s => s.id);
  const expectedId = expectedSection(skillSections, q.expectedSection)?.id ?? '';

  const inTop3 = top3Ids.includes(expectedId);
  const inTop1 = top3.length > 0 && top3[0]!.id === expectedId;

  const isReal = !q.notes.startsWith('Synthetic');

  total++;
  if (inTop1) correctTop1++;
  if (inTop3) correctTop3++;
  if (isReal) { realTotal++; if (inTop3) realCorrectTop3++; }
  else { syntheticTotal++; if (inTop3) syntheticCorrectTop3++; }

  results.push({ query: q.query, skill: q.skill, expected: expectedId, top3: top3Ids, pass: inTop3 });
}

// Print detailed results
console.log('=== P1 Eval Results ===\n');
let failures = 0;
for (const r of results) {
  const marker = r.pass ? '✓' : '✗';
  if (!r.pass) failures++;
  console.log(`  ${marker} query="${r.query}" on ${r.skill}`);
  console.log(`       expected=${r.expected}`);
  console.log(`       top3=[${r.top3.join(', ')}]`);
}
console.log('');

// Summary
console.log(`Total queries: ${total}`);
console.log(`precision@1: ${(correctTop1 / total * 100).toFixed(1)}% (${correctTop1}/${total})`);
console.log(`precision@3: ${(correctTop3 / total * 100).toFixed(1)}% (${correctTop3}/${total})`);

if (realTotal > 0) console.log(`precision@3 (real queries): ${(realCorrectTop3 / realTotal * 100).toFixed(1)}% (${realCorrectTop3}/${realTotal})`);
if (syntheticTotal > 0) console.log(`precision@3 (synthetic queries): ${(syntheticCorrectTop3 / syntheticTotal * 100).toFixed(1)}% (${syntheticCorrectTop3}/${syntheticTotal})`);

console.log(`\nTarget: 80.0%`);
const pass = (correctTop3 / total) >= 0.8;
console.log(`Result: ${pass ? 'PASS' : 'FAIL'} (${(correctTop3 / total * 100).toFixed(1)}% vs 80.0% target)`);
if (failures > 0) console.log(`\nFailures: ${failures} queries missed top3`);
