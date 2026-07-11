import type { SkillSection, SkillStore } from '../types.js';

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function values(store: SkillStore | SkillSection[]): SkillSection[] {
  if (Array.isArray(store)) return store;
  return store instanceof Map ? [...store.values()] : Object.values(store);
}

// ---------------------------------------------------------------------------
// BM25F — field-weighted, with per-field saturation and boost weights.
// These are untuned starting defaults from the merged spec §2.3.
// ---------------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

// Field weights (untuned starting defaults)
const W_HEADING_PATH = 3.0;
const W_KEYWORDS = 2.5;
const W_SKILL_NAME = 1.5;
const W_SUMMARY = 1.5;
const W_BODY_HEAD = 0.5;

// Top-level H1 sections repeat generic skill names across every indexed field;
// score data showed that retaining 15% of their aggregate BM25F score prevents
// that duplicate contribution from outranking specific sections while keeping
// the overview searchable. H1 is derived from the production section ID's
// heading-path slug, rather than from title text or metadata.
const TOP_LEVEL_SECTION_MULTIPLIER = 0.15;

// Field names for the optional metadata on SkillSection.
// We derive the "field text" from whichever section properties are available.
interface FieldText {
  headingPath: string;
  keywords: string;
  summary: string;
  skillName: string;
  bodyHead: string;
}

function extractFields(section: SkillSection): FieldText {
  // headingPath: best-effort from title (the section's own heading text)
  const headingPath = section.title ?? '';
  // keywords: stored as optional string[] on SkillSection
  const keywords = (section.keywords ?? []).join(' ');
  // summary: stored as optional string
  const summary = section.summary ?? '';
  // skillName: derived from manifestId (format: system::skillName::hash8)
  let skillName = '';
  if (section.manifestId) {
    const parts = section.manifestId.split('::');
    if (parts.length >= 2) skillName = parts[1]!;
  }
  // bodyHead: first ~200 tokens of content
  const contentTokens = tokenize(section.content);
  const bodyHead = contentTokens.slice(0, 200).join(' ');
  return { headingPath, keywords, summary, skillName, bodyHead };
}

function fieldLength(field: string): number {
  return tokenize(field).length;
}

function isTopLevelSection(section: SkillSection): boolean {
  const idParts = section.id.split('::');
  if (idParts.length < 4) return false;
  return !(idParts.at(-1) ?? '').includes('--');
}

function avgFieldLength(fields: FieldText[]): FieldText {
  const n = fields.length || 1;
  const avg: FieldText = { headingPath: '', keywords: '', summary: '', skillName: '', bodyHead: '' };
  for (const key of Object.keys(avg) as (keyof FieldText)[]) {
    const sum = fields.reduce((s, f) => s + fieldLength(f[key]), 0);
    avg[key] = sum / n + ''; // store as stringified number; we'll parse it back
  }
  return avg;
}

// Store avgFieldLength as a plain object since FieldText is string-typed
const avgStore = new WeakMap<SkillSection[], { headingPath: number; keywords: number; summary: number; skillName: number; bodyHead: number }>();

function scoreField(queryTerms: string[], fieldText: string, weight: number, avgLen: number, fieldLen: number): number {
  if (!fieldText || fieldLen === 0) return 0;
  const fieldTerms = tokenize(fieldText);
  let score = 0;
  for (const qt of queryTerms) {
    const tf = fieldTerms.filter(t => t === qt).length;
    if (tf > 0) {
      // BM25 term saturation with length normalization
      const norm = 1 - B + B * (fieldLen / avgLen);
      score += weight * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
  }
  return score;
}

export function scoreSection(query: string, section: SkillSection, fields?: FieldText, avgs?: { headingPath: number; keywords: number; summary: number; skillName: number; bodyHead: number }): number {
  if (!query.trim()) return 0;
  const queryTerms = tokenize(query);
  if (!queryTerms.length) return 0;

  const f = fields ?? extractFields(section);
  const a = avgs ?? { headingPath: 1, keywords: 1, summary: 1, skillName: 1, bodyHead: 1 };

  const score = (
    scoreField(queryTerms, f.headingPath, W_HEADING_PATH, a.headingPath, fieldLength(f.headingPath)) +
    scoreField(queryTerms, f.keywords, W_KEYWORDS, a.keywords, fieldLength(f.keywords)) +
    scoreField(queryTerms, f.summary, W_SUMMARY, a.summary, fieldLength(f.summary)) +
    scoreField(queryTerms, f.skillName, W_SKILL_NAME, a.skillName, fieldLength(f.skillName)) +
    scoreField(queryTerms, f.bodyHead, W_BODY_HEAD, a.bodyHead, fieldLength(f.bodyHead))
  );

  return isTopLevelSection(section) ? score * TOP_LEVEL_SECTION_MULTIPLIER : score;
}

export function searchSections(store: SkillStore | SkillSection[], query: string): SkillSection[] {
  const arr = values(store);
  if (arr.length === 0) return [];

  // Pre-compute field texts and average lengths
  const fieldTexts = arr.map(extractFields);
  const avgs = {
    headingPath: avgFieldLength(fieldTexts.map(f => ({ ...f, headingPath: f.headingPath, keywords: f.keywords, summary: f.summary, skillName: f.skillName, bodyHead: f.bodyHead })) as any[]).headingPath as any as number,
    keywords: 0, summary: 0, skillName: 0, bodyHead: 0
  };
  // Recompute properly
  const n = arr.length || 1;
  avgs.headingPath = fieldTexts.reduce((s, f) => s + fieldLength(f.headingPath), 0) / n || 1;
  avgs.keywords = fieldTexts.reduce((s, f) => s + fieldLength(f.keywords), 0) / n || 1;
  avgs.summary = fieldTexts.reduce((s, f) => s + fieldLength(f.summary), 0) / n || 1;
  avgs.skillName = fieldTexts.reduce((s, f) => s + fieldLength(f.skillName), 0) / n || 1;
  avgs.bodyHead = fieldTexts.reduce((s, f) => s + fieldLength(f.bodyHead), 0) / n || 1;

  return arr
    .map((section, i) => ({ section, score: scoreSection(query, section, fieldTexts[i], avgs) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id))
    .map(item => item.section);
}
