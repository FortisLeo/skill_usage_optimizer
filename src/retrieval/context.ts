import { readFileSync, realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import type { LoadedReference, OmittedItem, ReferenceRef, RetrievalBundle, RetrievalRequest, SkillSection, SkillStore } from '../types.js';
import { searchSections } from '../search/lexical.js';

export function loadContext(store: SkillStore, queryOrRequest: string | RetrievalRequest): RetrievalBundle {
  const legacy = typeof queryOrRequest === 'string';
  const request = legacy ? { query: queryOrRequest } : queryOrRequest;
  const query = request.query?.trim() ?? '';
  if (legacy && !query) return { sections: [], context: '' };

  const all = values(store).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const omitted: OmittedItem[] = [];
  const picked: SkillSection[] = [];
  const add = (sections: SkillSection[]) => {
    for (const section of sections) {
      if (!picked.some(s => s.id === section.id)) picked.push(section);
    }
  };

  const isDefaultRequest = !legacy && !query && !request.phase && !request.includeReferences;

  add(all.filter(section => section.class === 'always' || section.policy?.alwaysInclude));

  const phaseSections = all.filter(section => section.class === 'phase');
  if (isDefaultRequest) {
    add(phaseSections);
  } else if (request.phase?.trim()) {
    add(searchSections(phaseSections, request.phase.trim()));
  } else if (query) {
    add(searchSections(phaseSections, query));
  }

  if (isDefaultRequest) {
    add(all.filter(section => section.class === 'on_demand'));
  } else if (query) {
    add(searchSections(all.filter(section => section.class === 'on_demand'), query));
  }

  const refTargets = new Set(picked.flatMap(section => section.references ?? []).map(ref => ref.target));
  if (request.includeReferences || refTargets.size) {
    add(all.filter(section => section.class === 'reference' && (request.includeReferences || refTargets.has(section.id) || refTargets.has(section.title) || (section.sourcePath && refTargets.has(section.sourcePath)))));
  }

  if (legacy && picked.length === 0 && query) add(searchSections(all, query));

  if (query || request.phase || request.includeReferences) {
    for (const section of all) {
      if (!picked.some(s => s.id === section.id) && (section.class === 'on_demand' || section.class === 'reference')) {
        omitted.push({ id: section.id, reason: 'no_match' });
      }
    }
  }

  const budgeted: SkillSection[] = [];
  let totalBytes = 0;
  for (const section of picked) {
    const mandatory = section.class === 'always' || section.policy?.alwaysInclude;
    const size = sectionBytes(section);
    if (!mandatory && request.maxBytes !== undefined && totalBytes + size > request.maxBytes) {
      omitted.push({ id: section.id, reason: 'budget' });
      continue;
    }
    totalBytes += size;
    budgeted.push(section);
  }

  const referenceBudget = request.maxBytes !== undefined ? Math.max(0, request.maxBytes - totalBytes) : Infinity;
  const references = collectReferences(budgeted, all, Boolean(request.includeReferences), referenceBudget, omitted);
  const bundle: RetrievalBundle = { sections: budgeted, context: budgeted.map(formatSection).join('\n\n') };
  if (!legacy || budgeted.length > 0) bundle.totalBytes = totalBytes;
  if (references.length) bundle.references = references;
  if (omitted.length) bundle.omitted = omitted;
  return bundle;
}

function formatSection(section: SkillSection): string {
  return `# ${section.title}\n${section.content}`;
}

function values(store: SkillStore | SkillSection[]): SkillSection[] {
  if (Array.isArray(store)) return store;
  return store instanceof Map ? [...store.values()] : Object.values(store);
}

function sectionBytes(section: SkillSection): number {
  return section.byteLength ?? Buffer.byteLength(section.content, 'utf-8');
}

function collectReferences(sections: SkillSection[], all: SkillSection[], includeUnresolved: boolean, budget: number, omitted: OmittedItem[]): LoadedReference[] {
  const refs = new Map<string, ReferenceRef>();
  for (const section of sections) {
    for (const ref of section.references ?? []) refs.set(`${ref.kind}:${ref.target}`, ref);
  }

  const loaded: LoadedReference[] = [];
  for (const ref of refs.values()) {
    // First: try matching against existing store sections
    const resolved = all.find(section => ref.target === section.id || ref.target === section.title || ref.target === section.sourcePath);
    if (resolved) {
      const bytes = Buffer.byteLength(resolved.content, 'utf-8');
      if (bytes > budget) {
        loaded.push({ ref: { ...ref, resolved: true } });
        omitted.push({ id: ref.target, reason: 'budget' });
      } else {
        budget -= bytes;
        loaded.push({ ref: { ...ref, resolved: true }, content: resolved.content });
      }
      continue;
    }

    // Second: try loading resolved file refs from disk (with TOCTOU re-validation)
    if (ref.kind === 'file' && ref.resolved && ref.absolutePath) {
      try {
        const real = realpathSync(ref.absolutePath);
        // ponytail: re-validate against stored sourceRoot to catch symlink swaps since compile
        if (ref.sourceRoot) {
          const rel = relative(ref.sourceRoot, real);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('escaped source root');
        }
        const content = readFileSync(ref.absolutePath, 'utf-8');
        const bytes = Buffer.byteLength(content, 'utf-8');
        if (bytes > budget) {
          loaded.push({ ref: { ...ref, resolved: true } });
          omitted.push({ id: ref.target, reason: 'budget' });
        } else {
          budget -= bytes;
          loaded.push({ ref: { ...ref, resolved: true }, content });
        }
      } catch {
        // File disappeared or escaped source root since compile — mark unresolved
        loaded.push({ ref: { ...ref, resolved: false } });
        omitted.push({ id: ref.target, reason: 'reference_unresolved' });
      }
      continue;
    }

    // Unresolved refs
    if (includeUnresolved) {
      loaded.push({ ref: { ...ref, resolved: false } });
      omitted.push({ id: ref.target, reason: 'reference_unresolved' });
    }
  }
  return loaded;
}
