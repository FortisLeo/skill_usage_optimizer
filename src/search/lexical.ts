import type { SkillSection, SkillStore } from '../types.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function values(store: SkillStore | SkillSection[]): SkillSection[] {
  if (Array.isArray(store)) return store;
  return store instanceof Map ? [...store.values()] : Object.values(store);
}

// ponytail: BM25-lite — TF saturation + title boost, no IDF corpus stats needed
const K1 = 1.5;
const TITLE_BOOST = 3;

export function scoreSection(query: string, section: SkillSection): number {
  if (!query.trim()) return 0;
  const queryTerms = tokenize(query);
  if (!queryTerms.length) return 0;

  const titleTerms = tokenize(section.title);
  const contentTerms = tokenize(section.content);

  let score = 0;
  for (const qt of queryTerms) {
    const tfTitle = titleTerms.filter(t => t === qt).length;
    const tfContent = contentTerms.filter(t => t === qt).length;
    const freq = tfContent + tfTitle * TITLE_BOOST;
    if (freq > 0) {
      score += freq / (freq + K1);
    }
  }

  return score / queryTerms.length;
}

export function searchSections(store: SkillStore | SkillSection[], query: string): SkillSection[] {
  return values(store)
    .map(section => ({ section, score: scoreSection(query, section) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
    .map(item => item.section);
}
