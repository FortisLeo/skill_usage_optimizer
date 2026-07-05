import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve as resolvePath, isAbsolute } from 'node:path';
import type { DiscoveryContext, NormalizedSkillInput, ReferenceRef, SkillManifest, SkillSection } from '../types.js';
import { parseMarkdown, type ParsedSection } from '../parser/markdown.js';
import { extractReferences } from '../retrieval/references.js';
import { classifyHeading } from './classify.js';
import { sectionId } from './ids.js';
import { extractPolicyLines } from './policy.js';

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
      order
    };
  });
}

export function buildManifest(input: NormalizedSkillInput, sections: SkillSection[]): SkillManifest {
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
    byteLength: sections.reduce((sum, section) => sum + (section.byteLength ?? Buffer.byteLength(section.content, 'utf-8')), 0)
  };
}

function countTokens(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
