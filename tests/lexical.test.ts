import { describe, expect, it } from 'vitest';
import { scoreSection, searchSections } from '../src/search/lexical.js';
import type { SkillSection } from '../src/types.js';

function makeSection(overrides: Partial<SkillSection> = {}): SkillSection {
  return { id: 'test::section', title: 'Test Section', content: 'Some test content here.', hash: 'abc123', ...overrides };
}

describe('scoreSection', () => {
  it('returns 0 for empty query', () => {
    expect(scoreSection('', makeSection({ title: 'Overview', content: 'Overview content' }))).toBe(0);
    expect(scoreSection('  ', makeSection())).toBe(0);
  });

  it('title token match scores higher than content-only match', () => {
    expect(scoreSection('Setup', makeSection({ title: 'Setup', content: '' }))).toBeGreaterThan(scoreSection('Setup', makeSection({ title: 'Other', content: 'Setup' })));
  });

  it('scores title token match and repeated content matches', () => {
    expect(scoreSection('Trouble', makeSection({ title: 'Trouble Guide', content: '' }))).toBeGreaterThan(0);
    expect(scoreSection('validate', makeSection({ title: 'Notes', content: 'validate here and validate there, always validate.' }))).toBeGreaterThan(0);
    // multi-word query: both terms match = higher average than one missing
    expect(scoreSection('hello world', makeSection({ title: 'Notes', content: 'hello world here' }))).toBeGreaterThan(scoreSection('hello zebra', makeSection({ title: 'Notes', content: 'hello world here' })));
  });
});

describe('searchSections', () => {
it('returns sections ranked by score descending', () => {
    const results = searchSections({
      a: makeSection({ id: 'a', title: 'Setup', content: 'Setting things up.' }),
      b: makeSection({ id: 'b', title: 'Troubleshooting', content: 'Fix setup issues. Setup guide.' }),
      c: makeSection({ id: 'c', title: 'References', content: 'Some links.' }),
    }, 'Setup');
    expect(results[0]!.id).toBe('a');
  });

  it('accepts Map and Record stores', () => {
    expect(searchSections(new Map([['b', makeSection({ id: 'b', title: 'Usage', content: 'Usage details.' })]]), 'Usage')[0]!.id).toBe('b');
    expect(searchSections({ x: makeSection({ id: 'x', title: 'Examples', content: 'Example code here.' }) }, 'Examples')[0]!.id).toBe('x');
  });

  it('returns empty array when no sections match or store is empty', () => {
    expect(searchSections({ a: makeSection({ id: 'a', title: 'Overview', content: '' }) }, 'xylophone')).toEqual([]);
    expect(searchSections({}, 'anything')).toEqual([]);
    expect(searchSections(new Map(), 'anything')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const store = { a: makeSection({ id: 'a', title: 'Setup', content: '' }) };
    expect(searchSections(store, 'SETUP')).toHaveLength(1);
    expect(searchSections(store, 'setup')).toHaveLength(1);
  });

  it('still returns a top-level section for an overview query', () => {
    const overview = makeSection({
      id: 'opencode::skill::hash1234::overview',
      title: 'Overview',
      content: 'Overview of the skill.',
      keywords: ['overview', 'skill'],
      summary: 'Overview of the skill',
    });
    const specific = makeSection({
      id: 'opencode::skill::hash1234::overview--setup',
      title: 'Setup',
      content: 'Setup details.',
      keywords: ['setup'],
      summary: 'Setup details',
    });

    expect(searchSections([overview, specific], 'overview')).toContainEqual(overview);
  });

  it('higher score for more repeated term occurrences', () => {
    const single = makeSection({ id: 's', title: 'Notes', content: 'validate once.' });
    const repeated = makeSection({ id: 'r', title: 'Notes', content: 'validate validate validate validate validate.' });
    expect(scoreSection('validate', repeated)).toBeGreaterThan(scoreSection('validate', single));
  });

  it('title match boosts score above content-only match', () => {
    const titleHit = makeSection({ id: 't', title: 'Setup Guide', content: 'Some unrelated text.' });
    const contentHit = makeSection({ id: 'c', title: 'Other', content: 'Setup in the middle of text.' });
    expect(scoreSection('Setup', titleHit)).toBeGreaterThan(scoreSection('Setup', contentHit));
  });

  it('stable tie order by id', () => {
    const results = searchSections({
      z: makeSection({ id: 'z', title: 'Notes', content: 'setup' }),
      a: makeSection({ id: 'a', title: 'Other', content: 'setup' }),
    }, 'setup');
    // Both score the same with BM25 (same freq), tie-broken by id
    expect(results[0]!.id).toBe('a');
    expect(results[1]!.id).toBe('z');
  });
});
