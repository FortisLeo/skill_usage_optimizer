import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/parser/markdown.js';

describe('parseMarkdown', () => {
  it('splits a markdown document into sections by headings', () => {
    const md = '# Overview\n\nSome text.\n\n## Setup\n\nSetup steps.\n\n## Usage\n\nUsage info.\n';
    const result = parseMarkdown(md);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.heading).toBe('Overview');
    expect(result.sections[0]!.level).toBe(1);
    expect(result.sections[0]!.slug).toBe('overview');
    expect(result.sections[0]!.content).toContain('Some text.');

    const children = result.sections[0]!.children;
    expect(children).toHaveLength(2);
    expect(children[0]!.heading).toBe('Setup');
    expect(children[0]!.slug).toBe('setup');
    expect(children[0]!.content).toContain('Setup steps.');
    expect(children[1]!.heading).toBe('Usage');
    expect(children[1]!.slug).toBe('usage');
  });

  it('builds nested heading paths', () => {
    const md = '## Setup\n\nSetup text.\n\n### Prerequisites\n\nNode.js.\n\n### Configuration\n\nConfig text.\n';
    const result = parseMarkdown(md);
    expect(result.sections).toHaveLength(1);
    const setup = result.sections[0]!;
    expect(setup.heading).toBe('Setup');
    expect(setup.path).toEqual(['Setup']);
    expect(setup.children).toHaveLength(2);

    const prereqs = setup.children[0]!;
    expect(prereqs.heading).toBe('Prerequisites');
    expect(prereqs.path).toEqual(['Setup', 'Prerequisites']);

    const config = setup.children[1]!;
    expect(config.heading).toBe('Configuration');
    expect(config.path).toEqual(['Setup', 'Configuration']);
  });

  it('deeply nested headings produce correct paths', () => {
    const md = '# A\n\n## B\n\n### C\n\n#### D\n\n##### E';
    const result = parseMarkdown(md);
    const a = result.sections[0]!;
    expect(a.path).toEqual(['A']);
    const b = a.children[0]!;
    expect(b.path).toEqual(['A', 'B']);
    const c = b.children[0]!;
    expect(c.path).toEqual(['A', 'B', 'C']);
    const d = c.children[0]!;
    expect(d.path).toEqual(['A', 'B', 'C', 'D']);
    const e = d.children[0]!;
    expect(e.path).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('ignores # inside fenced code blocks', () => {
    const md = '## Real Heading\n\n```\n# This is not a heading\n## Neither is this\n```\n\n## Another Real Heading\n\nReal content.\n';
    const result = parseMarkdown(md);
    // Should only have 2 top-level sections: "Real Heading" and "Another Real Heading"
    // The ### inside code fences should NOT create extra sections
    const headingNames = result.sections.map(s => s.heading);
    expect(headingNames).toEqual(['Real Heading', 'Another Real Heading']);
  });

  it('handles markdown with no headings - Instructions fallback', () => {
    const md = 'Just some text.\n\nNo headings here.\n\nMore text.';
    const result = parseMarkdown(md);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.heading).toBe('Instructions');
    expect(result.sections[0]!.content).toBe(md);
    expect(result.preamble).toBe('Just some text.\n\nNo headings here.\n\nMore text.');
  });

  it('handles headings at various levels (# through ######)', () => {
    const md = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6';
    const result = parseMarkdown(md);
    expect(result.sections).toHaveLength(1);
    const h1 = result.sections[0]!;
    expect(h1.level).toBe(1);
    expect(h1.heading).toBe('H1');

    let current = h1;
    for (let i = 2; i <= 6; i++) {
      expect(current.children).toHaveLength(1);
      current = current.children[0]!;
      expect(current.level).toBe(i);
      expect(current.heading).toBe(`H${i}`);
    }
  });

  it('generates correct slugs for headings with special characters', () => {
    const md = '# Hello World!\n\n## Setup & Configuration\n\n### What\'s Next?';
    const result = parseMarkdown(md);
    expect(result.sections[0]!.slug).toBe('hello-world');
    const setup = result.sections[0]!.children[0]!;
    expect(setup.slug).toBe('setup-configuration');
    const next = setup.children[0]!;
    expect(next.slug).toBe('what-s-next');
  });

  it('handles preamble content before any heading', () => {
    const md = 'This is preamble text.\n\nMore preamble.\n\n## First Heading\n\nSection content.';
    const result = parseMarkdown(md);
    expect(result.preamble).toBe('This is preamble text.\n\nMore preamble.');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.heading).toBe('First Heading');
  });

  it('handles empty markdown', () => {
    const result = parseMarkdown('');
    expect(result.sections).toHaveLength(0);
    expect(result.preamble).toBe('');
  });
});
