import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve as resolvePath, isAbsolute } from 'node:path';
import type { DiscoveryContext, NormalizedSkillInput, ReferenceRef, SkillConflictDiagnostic, SkillManifest, SkillSection, RelatedEdge } from '../types.js';
import { parseMarkdown, type ParsedSection } from '../parser/markdown.js';
import { extractReferences } from '../retrieval/references.js';
import { classifyHeading } from './classify.js';
import { sectionId } from './ids.js';
import { extractPolicyLines } from './policy.js';
import { extractIdentifiers, extractProvidedSymbols, extractUsedSymbols } from '../search/identifiers.js';

function flatten(sections: ParsedSection[]): ParsedSection[] {
  return sections.flatMap(section => [section, ...flatten(section.children)]);
}

function resolveFileRefs(refs: ReferenceRef[], sourcePath: string, _ctx: DiscoveryContext): ReferenceRef[] {
  const sourceDir = resolvePath(sourcePath, '..');
  // ponytail: scope file refs to the source artifact boundary only, not the union of workspace/home/system roots
  let sourceRoot: string;
  try { sourceRoot = realpathSync(sourceDir); } catch { sourceRoot = sourceDir; }
  return refs.map(ref => {
    if (ref.kind !== 'file') return ref;
    const absolute = resolvePath(sourceDir, ref.target);
    let real: string;
    try { real = realpathSync(absolute); } catch { return { ...ref, resolved: false }; }
    const rel = relative(sourceRoot, real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { ...ref, absolutePath: real, resolved: true, sourceRoot };
    }
    return { ...ref, resolved: false };
  });
}

export function buildSections(input: NormalizedSkillInput, ctx: DiscoveryContext, seenIds: Map<string, number>): SkillSection[] {
  const parsed = parseMarkdown(input.rawMarkdown);

  // ponytail: preamble becomes always section only when real (non-fenced) headings exist — parser auto-wraps headingless preamble
  const allParsed: ParsedSection[] = parsed.sections.slice();
  if (!parsed.headingless && parsed.preamble) {
    allParsed.unshift({ level: 1, heading: 'Preamble', title: 'Preamble', slug: 'preamble', content: parsed.preamble, path: ['Preamble'], headingPath: ['Preamble'], children: [] });
  }

  const manifestId = `${input.system}::${input.skillName}::${input.sourceHash.slice(0, 8)}`;

  return flatten(allParsed).map((section, order) => {
    const content = section.content.trim();
    const id = sectionId(manifestId, section.headingPath, content, seenIds);
    const hash = createHash('sha256').update(content).digest('hex');
    const policyLines = extractPolicyLines(content);
    const byteLength = Buffer.byteLength(content, 'utf-8');

    const headingWords = section.heading.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Guardrail 3: only aggregate into empty-bodied parents with children
    let summary = '';
    let keywords = [...headingWords];
    let provides: string[] = [];
    let uses: string[] = [];
    let codeIdentifiers: string[] = [];

    if (content) {
      // Normal case: section has its own body text
      const firstPara = content.split('\n\n').find(p => p.trim().length > 0 && !p.trim().startsWith('```'));
      summary = firstPara ? firstPara.replace(/^[^a-zA-Z0-9]*/, '').split(/[.!?]/).filter(Boolean)[0]?.trim() ?? '' : '';
      const codeBlocks = extractFenceContent(content);
      const codeText = codeBlocks.join('\n');
      codeIdentifiers = extractIdentifiers(codeText);
      keywords = [...new Set([...headingWords, ...codeIdentifiers])];
      provides = extractProvidedSymbols(codeText);
      uses = extractUsedSymbols(codeText);
    } else if (section.children.length > 0) {
      // Empty-bodied parent with children: aggregate child metadata (Guarail 1+3)
      const childWords = new Set<string>();
      const childSentences: string[] = [];
      for (const child of section.children) {
        const childContent = child.content.trim();
        if (childContent) {
          child.heading.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2).forEach((w: string) => childWords.add(w));
          const childCode = extractIdentifiers(childContent);
          childCode.forEach((w: string) => childWords.add(w));
          const firstPara = childContent.split('\n\n').find((p: string) => p.trim().length > 0 && !p.trim().startsWith('```'));
          if (firstPara) {
            const firstSentence = firstPara.replace(/^[^a-zA-Z0-9]*/, '').split(/[.!?]/).filter(Boolean)[0]?.trim();
            if (firstSentence) childSentences.push(firstSentence);
          }
        }
      }
      if (childWords.size > 0) {
        keywords = [...new Set([...headingWords, ...childWords])];
      }
      if (childSentences.length > 0) {
        summary = childSentences.join('. ');
      }
    }

    // Extract requires/related from HTML comments: <!-- requires: ... --> and <!-- related: ... -->
    const requires = extractRequireDeclarations(content);
    const related = extractRelatedDeclarations(content);

    return {
      id,
      title: section.heading,
      content,
      hash,
      system: input.system,
      sourcePath: input.sourcePath,
      sourceHash: input.sourceHash,
      mtimeMs: input.mtimeMs,
      size: input.size,
      manifestId,
      class: classifyHeading(section.heading),
      policy: policyLines.length ? { lines: policyLines, alwaysInclude: true } : undefined,
      references: resolveFileRefs(extractReferences(content), input.sourcePath, ctx),
      tokenCount: countTokens(section.heading + '\n' + content),
      byteLength,
order,
      summary,
      keywords,
      provides,
      uses,
      requires,
      related,
    };
  });
}

export function buildManifest(
  input: NormalizedSkillInput,
  sections: SkillSection[],
  precedence?: number,
  conflicts?: SkillConflictDiagnostic[]
): SkillManifest {
  return {
    id: `${input.system}::${input.skillName}::${input.sourceHash.slice(0, 8)}`,
    skillName: input.skillName,
    system: input.system,
    kind: input.kind,
    description: input.description,
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    sections: sections.map(section => ({
      id: section.id,
      title: section.title,
      class: section.class ?? 'phase',
      tokenCount: section.tokenCount ?? countTokens(section.title + '\n' + section.content),
      byteLength: section.byteLength ?? Buffer.byteLength(section.content, 'utf-8'),
      references: section.references ?? [],
      policy: section.policy,
      order: section.order ?? 0
    })),
    tokenCount: sections.reduce((sum, section) => sum + (section.tokenCount ?? countTokens(section.title + '\n' + section.content)), 0),
    byteLength: sections.reduce((sum, section) => sum + (section.byteLength ?? Buffer.byteLength(section.content, 'utf-8')), 0),
    precedence,
    conflicts
  };
}

function countTokens(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function extractRequireDeclarations(content: string): string[] {
  const match = content.match(/<!--\s*requires:\s*([^>]+)\s*-->/);
  if (!match) return [];
  return match[1]!.split(',').map(s => s.trim()).filter(Boolean);
}

function extractRelatedDeclarations(content: string): RelatedEdge[] {
  const match = content.match(/<!--\s*related:\s*([^>]+)\s*-->/);
  if (!match) return [];
  return match[1]!.split(',').map(pair => {
    const [id, weightStr] = pair.trim().split(':');
    return {
      id: id?.trim() ?? '',
      weight: weightStr ? parseFloat(weightStr) : 0.5,
      source: 'author' as const,
    };
  }).filter(r => r.id.length > 0);
}

function extractFenceContent(text: string): string[] {
  const blocks: string[] = [];
  let inFence = false;
  let fenceContent = '';
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (inFence) { blocks.push(fenceContent); fenceContent = ''; }
      inFence = !inFence;
    } else if (inFence) {
      fenceContent += (fenceContent ? '\n' : '') + line;
    }
  }
  return blocks;
}
