import type { ReferenceRef } from '../types.js';

export function extractMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]!);
}

export function extractReferences(markdown: string): ReferenceRef[] {
  return extractMarkdownLinks(markdown).map(target => ({ target, kind: classifyReference(target) }));
}

function classifyReference(target: string): ReferenceRef['kind'] {
  if (/^https?:\/\//i.test(target)) return 'url';
  if (/^skill:/i.test(target) || target.startsWith('@skill/')) return 'skill';
  return 'file';
}
