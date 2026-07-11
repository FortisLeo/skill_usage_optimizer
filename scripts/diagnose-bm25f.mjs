import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compile } from '../dist/compiler/index.js';
import { normalize } from '../dist/normalize/index.js';
import { searchSections } from '../dist/search/lexical.js';

const fixtureRoot = join(process.cwd(), 'tests', 'fixtures');
const queryFile = join(fixtureRoot, 'eval', 'queries.json');
const skillNames = ['well-structured', 'chrome-automation', 'database-ops'];
const ctx = {
  workspaceRoot: fixtureRoot,
  repoRoot: null,
  homeDir: fixtureRoot,
  includeGlobals: false,
  includeSystem: false,
  explicitRoots: []
};

const files = skillNames.map(name => join(
  fixtureRoot,
  name === 'well-structured' ? 'compiler' : 'eval',
  `${name}.md`
));
const artifacts = files.map(absolutePath => {
  const stat = statSync(absolutePath);
  return {
    system: 'opencode',
    kind: 'instruction_file',
    absolutePath,
    relativePath: relative(fixtureRoot, absolutePath),
    rootOrigin: fixtureRoot,
    precedence: 70,
    configIndirection: null,
    rawStat: { mtimeMs: stat.mtimeMs, size: stat.size }
  };
});

const normalized = normalize(artifacts, ctx);
if (normalized.errors.length) throw new Error(normalized.errors.map(e => e.error).join('; '));
const compiled = compile(normalized.inputs, ctx);
if (compiled.errors.length) throw new Error(compiled.errors.map(e => e.error).join('; '));

const sectionsBySkill = Object.fromEntries(skillNames.map(skill => [
  skill,
  [...compiled.store.values()].filter(section => section.manifestId?.includes(`::${skill}::`))
]));
const queries = JSON.parse(readFileSync(queryFile, 'utf8'));
const failures = queries.filter(query => {
  const sections = sectionsBySkill[query.skill];
  const expected = sections.find(section => section.id.endsWith(`--${query.expectedSection}`));
  return expected && !searchSections(sections, query.query).slice(0, 3).some(section => section.id === expected.id);
});

const K1 = 1.5;
const B = 0.75;
const weights = { headingPath: 3, keywords: 2.5, summary: 1.5, skillName: 1.5, bodyHead: 0.5 };
const fields = ['headingPath', 'keywords', 'summary', 'skillName', 'bodyHead'];
const tokenize = text => text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const fieldLength = text => tokenize(text).length;

function fieldTexts(section) {
  const headingPath = section.title ?? '';
  const keywords = (section.keywords ?? []).join(' ');
  const summary = section.summary ?? '';
  const skillName = section.manifestId?.split('::')[1] ?? '';
  const bodyHead = tokenize(section.content).slice(0, 200).join(' ');
  return { headingPath, keywords, summary, skillName, bodyHead };
}

function averageLengths(sections) {
  const texts = sections.map(fieldTexts);
  return Object.fromEntries(fields.map(field => [
    field,
    Math.max(1, texts.reduce((sum, text) => sum + fieldLength(text[field]), 0) / sections.length)
  ]));
}

function contribution(query, text, field, averages) {
  const terms = tokenize(query);
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  const norm = 1 - B + B * (tokens.length / averages[field]);
  return terms.reduce((sum, term) => {
    const tf = tokens.filter(token => token === term).length;
    return sum + (tf ? weights[field] * ((tf * (K1 + 1)) / (tf + K1 * norm)) : 0);
  }, 0);
}

function detail(query, section, sections, averages) {
  const text = fieldTexts(section);
  const contributions = Object.fromEntries(fields.map(field => [field, contribution(query, text[field], field, averages)]));
  const suffix = section.id.split('::').at(-1) ?? '';
  const path = suffix.replace(/-[a-f0-9]{8}(?=$|--)/, '').split('--');
  const titlePath = path.map((_, index) => {
    const prefix = path.slice(0, index + 1).join('--');
    return sections.find(candidate => (candidate.id.split('::').at(-1) ?? '').replace(/-[a-f0-9]{8}(?=$|--)/, '') === prefix)?.title ?? path[index];
  });
  const directChildren = sections.some(child => {
    const childSuffix = child.id.split('::').at(-1) ?? '';
    return child !== section && childSuffix.startsWith(`${suffix}--`) && childSuffix.slice(suffix.length + 2).split('--').length === 1;
  });
  return {
    id: section.id,
    headingPath: titlePath.join(' > '),
    keywords: text.keywords,
    summary: text.summary,
    skillName: text.skillName,
    bodyHead: text.bodyHead,
    contributions,
    finalScore: Object.values(contributions).reduce((sum, value) => sum + value, 0),
    level: path.length,
    title: section.title,
    contentSize: section.content.length,
    childAggregationApplied: section.content.length === 0 && directChildren
  };
}

for (const query of failures) {
  const sections = sectionsBySkill[query.skill];
  const expected = sections.find(section => section.id.endsWith(`--${query.expectedSection}`));
  const winner = searchSections(sections, query.query)[0];
  const averages = averageLengths(sections);
  console.log(`\n=== ${query.skill}: ${query.query} ===`);
  console.log(`expected section: ${JSON.stringify(detail(query.query, expected, sections, averages))}`);
  console.log(`generic winning section: ${JSON.stringify(detail(query.query, winner, sections, averages))}`);
}
console.log(`\nReported ${failures.length} failing queries.`);
