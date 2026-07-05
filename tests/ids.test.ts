import { describe, expect, it } from 'vitest';
import { sectionId, slugHeadingPath } from '../src/compiler/ids.js';

describe('slugHeadingPath', () => {
  it('joins headings with double-dash separator', () => {
    expect(slugHeadingPath(['Setup', 'Prerequisites'])).toBe('setup--prerequisites');
  });

  it('single heading produces no double-dash', () => {
    expect(slugHeadingPath(['Overview'])).toBe('overview');
  });

  it('lowercases all text', () => {
    expect(slugHeadingPath(['HELLO', 'World'])).toBe('hello--world');
  });

  it('replaces non-alphanumeric with dashes', () => {
    expect(slugHeadingPath(["What's New?"])).toBe('what-s-new');
  });

  it('collapses multiple dashes', () => {
    expect(slugHeadingPath(['Foo---Bar'])).toBe('foo-bar');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugHeadingPath(['-Start-', '-End-'])).toBe('start--end');
  });

  it('empty headings array produces empty string', () => {
    expect(slugHeadingPath([])).toBe('');
  });

  it('headings with only special chars produce empty segments', () => {
    expect(slugHeadingPath(['!@#$%'])).toBe('');
  });

  it('mixed special chars and text', () => {
    expect(slugHeadingPath(['Hello World!', 'Setup & Configuration']))
      .toBe('hello-world--setup-configuration');
  });
});

describe('sectionId', () => {
  it('produces deterministic IDs from manifestId and heading path', () => {
    const seen = new Map<string, number>();
    const id1 = sectionId('claude::my-skill::abc12345', ['Setup', 'Prerequisites'], 'body1', seen);
    expect(id1).toBe('claude::my-skill::abc12345::setup--prerequisites');
  });

  it('same manifestId and headings produce same ID', () => {
    const seen1 = new Map<string, number>();
    const id1 = sectionId('sys::my-skill::abc', ['Overview'], 'body', seen1);

    const seen2 = new Map<string, number>();
    const id2 = sectionId('sys::my-skill::abc', ['Overview'], 'body', seen2);

    expect(id1).toBe(id2);
  });

  it('different manifestIds produce distinct IDs with same skillName and headings', () => {
    const seen = new Map<string, number>();
    const id1 = sectionId('claude::shared::aaa', ['Overview'], '', seen);
    const id2 = sectionId('opencode::shared::bbb', ['Overview'], '', seen);

    expect(id1).toBe('claude::shared::aaa::overview');
    expect(id2).toBe('opencode::shared::bbb::overview');
    expect(id1).not.toBe(id2);
  });

  it('first collision appends short-hash suffix', () => {
    const seen = new Map<string, number>();
    const id1 = sectionId('sys::skill::abc', ['Overview'], 'first body', seen);
    const id2 = sectionId('sys::skill::abc', ['Overview'], 'second body', seen);

    expect(id1).toBe('sys::skill::abc::overview');
    expect(id2).toMatch(/^sys::skill::abc::overview-[a-f0-9]{8}$/);
    expect(id2).not.toBe(id1);
  });

  it('second collision appends numeric counter -2', () => {
    const seen = new Map<string, number>();
    sectionId('sys::skill::abc', ['Overview'], 'same', seen);
    sectionId('sys::skill::abc', ['Overview'], 'same', seen);
    const id3 = sectionId('sys::skill::abc', ['Overview'], 'same', seen);

    expect(id3).toBe('sys::skill::abc::overview-2');
  });

  it('third collision appends -3', () => {
    const seen = new Map<string, number>();
    sectionId('sys::skill::abc', ['Overview'], 'same', seen);
    sectionId('sys::skill::abc', ['Overview'], 'same', seen);
    sectionId('sys::skill::abc', ['Overview'], 'same', seen);
    const id4 = sectionId('sys::skill::abc', ['Overview'], 'same', seen);

    expect(id4).toBe('sys::skill::abc::overview-3');
  });

  it('different heading paths produce different IDs', () => {
    const seen = new Map<string, number>();
    const id1 = sectionId('sys::skill::abc', ['Setup'], '', seen);
    const id2 = sectionId('sys::skill::abc', ['Setup', 'Config'], '', seen);

    expect(id1).toBe('sys::skill::abc::setup');
    expect(id2).toBe('sys::skill::abc::setup--config');
    expect(id1).not.toBe(id2);
  });

  it('different manifestIds produce different IDs even with same headings', () => {
    const seen = new Map<string, number>();
    const id1 = sectionId('sys::skill-a::aaa', ['Overview'], '', seen);
    const id2 = sectionId('sys::skill-b::bbb', ['Overview'], '', seen);

    expect(id1).toBe('sys::skill-a::aaa::overview');
    expect(id2).toBe('sys::skill-b::bbb::overview');
    expect(id1).not.toBe(id2);
  });

  it('empty heading path uses empty slug', () => {
    const seen = new Map<string, number>();
    const id = sectionId('sys::my-skill::abc', [], 'body', seen);
    expect(id).toBe('sys::my-skill::abc::');
  });
});
