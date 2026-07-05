export interface ParsedSection {
  level: number;
  heading: string;
  title: string;
  slug: string;
  content: string;
  path: string[];
  headingPath: string[];
  children: ParsedSection[];
}

export interface ParsedMarkdown {
  preamble: string;
  sections: ParsedSection[];
  /** true when parser found zero real (non-fenced) headings — safe for preamble promotion gating */
  headingless: boolean;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function trimSection(section: ParsedSection): void {
  section.content = section.content.trim();
  section.children.forEach(trimSection);
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const sections: ParsedSection[] = [];
  const stack: ParsedSection[] = [];
  let preamble = '';
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);

    if (match && !inFence) {
      const level = match[1]!.length;
      const heading = match[2]!.trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const parent = stack.at(-1);
      const headingPath = parent ? [...parent.headingPath, heading] : [heading];
      const section: ParsedSection = {
        level,
        heading,
        title: heading,
        slug: slug(heading),
        content: '',
        path: headingPath,
        headingPath,
        children: []
      };
      if (parent) parent.children.push(section);
      else sections.push(section);
      stack.push(section);
    } else if (stack.length) {
      const current = stack[stack.length - 1]!;
      current.content += (current.content ? '\n' : '') + line;
    } else {
      preamble += (preamble ? '\n' : '') + line;
    }
  }

  sections.forEach(trimSection);
  preamble = preamble.trim();
  const headingless = sections.length === 0;
  if (headingless && preamble) {
    sections.push({
      level: 1,
      heading: 'Instructions',
      title: 'Instructions',
      slug: 'instructions',
      content: preamble,
      path: ['Instructions'],
      headingPath: ['Instructions'],
      children: []
    });
  }

  return { preamble, sections, headingless };
}
