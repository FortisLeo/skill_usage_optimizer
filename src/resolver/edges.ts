// Edge inference: derive requires/related edges from cross-references and shared code symbols.
// Uses provides/uses metadata populated by Phase P1's manifest.ts.

import type { SkillSection } from '../types.js';
import type { RelatedEdge } from '../types.js';

export interface InferredEdge {
  targetSectionId: string;
  confidence: 'high' | 'medium' | 'low';
  type: 'requires' | 'related';
  source: 'cross_ref' | 'symbol_def_use' | 'heading_cue';
}

// ---------------------------------------------------------------------------
// Cross-reference edge inference
// Looks for intra-doc links, heading mentions, and "see" references
// ---------------------------------------------------------------------------

function extractCrossRefs(content: string): string[] {
  const refs = new Set<string>();

  // Markdown links to headings: [text](#heading-slug) or [text](<skill-slug>)
  const linkPattern = /\[([^\]]+)\]\(#([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(content)) !== null) {
    refs.add(match[2]!.toLowerCase());
  }

  // "see the *Section Name* section" or "the section above"
  const seePattern = /\b(see|refer to|check|using|follow|as described in)\s+["'`]?([A-Z][a-zA-Z\s-]+)["'`]?/g;
  while ((match = seePattern.exec(content)) !== null) {
    const mention = match[2]!.trim().toLowerCase().replace(/\s+/g, '-');
    if (mention.length > 3) refs.add(mention);
  }

  // "Step 1 / Step 2" ordinal cues
  const stepPattern = /\b(step|prerequisite|before you begin|first run)\b/i;
  if (stepPattern.test(content)) {
    // Step cues are weak signals — we return them separately
  }

  return [...refs];
}

// ---------------------------------------------------------------------------
// Symbol-based edge inference
// If a section uses a symbol that another section provides, that's a dependency signal.
// ---------------------------------------------------------------------------

function inferSymbolEdges(
  section: SkillSection,
  allSections: SkillSection[]
): InferredEdge[] {
  const edges: InferredEdge[] = [];

  if (!section.uses || section.uses.length === 0) return edges;

  for (const usedSymbol of section.uses) {
    // Find sections that provide this symbol
    const providers = allSections.filter(
      s => s.id !== section.id && s.provides?.includes(usedSymbol)
    );

    if (providers.length === 1) {
      // Single provider = strong signal — promote to requires
      edges.push({
        targetSectionId: providers[0]!.id,
        confidence: 'high',
        type: 'requires',
        source: 'symbol_def_use',
      });
    } else if (providers.length > 1) {
      // Multiple providers = weak signal — use as related
      for (const p of providers) {
        edges.push({
          targetSectionId: p.id,
          confidence: 'low',
          type: 'related',
          source: 'symbol_def_use',
        });
      }
    }
  }

  return edges;
}

// Derive heading slug from a section ID (last segment after ::)
function sectionSlug(id: string): string {
  const parts = id.split('::');
  return parts[parts.length - 1]?.toLowerCase() ?? '';
}

// ---------------------------------------------------------------------------
// Public API: infer all edges for a section
// ---------------------------------------------------------------------------

export function inferEdges(
  section: SkillSection,
  allSections: SkillSection[]
): InferredEdge[] {
  const edges: InferredEdge[] = [];

  // Cross-references
  const crossRefs = extractCrossRefs(section.content);
  for (const refSlug of crossRefs) {
    const target = allSections.find(
      s => s.id !== section.id && (
      s.id.toLowerCase().includes(refSlug) ||
      s.title.toLowerCase().replace(/\s+/g, '-') === refSlug ||
      sectionSlug(s.id) === refSlug
      )
    );
    if (target) {
      edges.push({
        targetSectionId: target.id,
        confidence: 'medium',
        type: 'related',
        source: 'cross_ref',
      });
    }
  }

  // Symbol def/use edges
  const symbolEdges = inferSymbolEdges(section, allSections);
  edges.push(...symbolEdges);

  // Heading cues: ordinal step headings suggest ordering but not hard deps
  // (handled by the resolver's topological sort based on hard requires only)

  return edges;
}

// ---------------------------------------------------------------------------
// Resolve inferred edges into a merged list of requires + related
// ---------------------------------------------------------------------------

export function mergeInferredEdges(
  section: SkillSection,
  allSections: SkillSection[]
): { requires: Set<string>; related: RelatedEdge[] } {
  const inferred = inferEdges(section, allSections);
  const requires = new Set<string>(section.requires ?? []);
  const related: RelatedEdge[] = [...(section.related ?? [])];

  for (const edge of inferred) {
    // Author declarations always win — if the author already declared this edge, skip
    if (requires.has(edge.targetSectionId)) continue;
    if (related.some(r => r.id === edge.targetSectionId)) continue;

    if (edge.type === 'requires' && edge.confidence === 'high') {
      requires.add(edge.targetSectionId);
    } else {
      related.push({
        id: edge.targetSectionId,
        weight: edge.confidence === 'high' ? 0.9 : edge.confidence === 'medium' ? 0.6 : 0.3,
        source: 'inferred',
      });
    }
  }

  return { requires, related };
}
