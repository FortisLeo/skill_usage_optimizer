import { createHash } from 'node:crypto';

export function slugHeadingPath(headings: string[]): string {
  return headings
    .map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('--');
}

function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

export function sectionId(manifestId: string, headings: string[], content: string, seenIds: Map<string, number>): string {
  const base = `${manifestId}::${slugHeadingPath(headings)}`;
  if (!seenIds.has(base)) {
    seenIds.set(base, 1);
    return base;
  }

  const hashed = `${base}-${shortHash(content)}`;
  if (!seenIds.has(hashed)) {
    seenIds.set(hashed, 1);
    return hashed;
  }

  let n = 2;
  while (seenIds.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  seenIds.set(id, 1);
  return id;
}
