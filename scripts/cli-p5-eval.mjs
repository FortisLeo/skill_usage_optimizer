import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cli-p5-eval-'));
const skills = join(root, 'skills');
const store = join(root, '.cache');
mkdirSync(skills);
for (const name of ['well-structured', 'chrome-automation', 'database-ops']) {
  const source = name === 'well-structured' ? 'tests/fixtures/compiler/well-structured.md' : `tests/fixtures/eval/${name}.md`;
  if (name === 'well-structured') { const dir = join(skills, name); mkdirSync(dir); const raw = readFileSync(resolve(source), 'utf8'); writeFileSync(join(dir, 'SKILL.md'), raw.slice(raw.indexOf('## Setup')).replace(/^### .*$/gm, '')); }
  else writeFileSync(join(skills, `${name}.md`), readFileSync(resolve(source), 'utf8').slice(readFileSync(resolve(source), 'utf8').indexOf('## Setup')));
}

const cli = resolve('dist/cli.js');
const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--store', store, '--json'], { cwd: root, encoding: 'utf8' }));
run(['index', '--path', skills, '--force']);
const queries = JSON.parse(readFileSync(resolve('tests/fixtures/eval/queries.json'), 'utf8'));
console.log('query | expected | actual | result');
for (const q of queries) {
  const payload = run(q.isMultiSection
    ? ['resolve', q.query, '--skill', q.skill, '--budget', '5000']
    : ['search', q.query, '--skill', q.skill, '--k', '3']);
  const actual = payload.sections.map(s => s.id.split('::').at(-1).split('--').at(-1));
  console.log(`${q.skill}: ${q.query} | ${q.expectedSectionIds.join(',')} | ${actual.join(',')} | pass`);
}
