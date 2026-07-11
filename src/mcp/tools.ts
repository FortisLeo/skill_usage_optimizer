// ponytail: pure MCP tool handlers with injected pipeline functions
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { DiscoveredArtifact, DiscoveryContext, NormalizedSkillInput, BoundaryError, DiscoverResult, NormalizeResult, RetrievalBundle, RetrievalRequest, SkillConflictDiagnostic, SkillManifest, SkillStore as TypesSkillStore, ResolveResult } from '../types.js';
import type { SkillSection } from '../store/fileStore.js';
import { computeHash, readSourceFile } from '../fs/freshness.js';
import { extractMarkdownLinks } from '../retrieval/references.js';
import { searchSections as defaultSearchSections } from '../search/lexical.js';
import { resolve as defaultResolve } from '../resolver/index.js';
import { doctor } from '../resolver/doctor.js';

export interface ToolDeps {
  discover: (ctx: DiscoveryContext) => DiscoverResult;
  normalize: (artifacts: DiscoveredArtifact[], ctx: DiscoveryContext) => NormalizeResult;
  compile: (inputs: NormalizedSkillInput[], ctx: DiscoveryContext) => { store: TypesSkillStore; errors: BoundaryError[]; manifests?: SkillManifest[]; diagnostics?: SkillConflictDiagnostic[] };
  loadContext: (store: TypesSkillStore, query: string | RetrievalRequest) => RetrievalBundle;
  store: {
    readIndex: () => Promise<Record<string, string>>;
    writeIndex: (entries: Record<string, string>) => Promise<void>;
    readSections: (ids: string[]) => Promise<Map<string, SkillSection>>;
    writeSections: (sections: Map<string, SkillSection>) => Promise<void>;
    readManifests: () => Promise<Record<string, SkillManifest>>;
    writeManifests: (manifests: Record<string, SkillManifest>) => Promise<void>;
    readSavings?: () => Promise<unknown>;
    writeSavings?: (records: unknown) => Promise<void>;
    clear: () => Promise<void>;
  };
  resolveHomeDir: () => string;
  resolveWorkspaceRoot: () => string;
  searchSections?: (store: TypesSkillStore | SkillSection[], query: string) => SkillSection[];
  resolve?: (store: TypesSkillStore | SkillSection[], request: { query: string; phase?: string; skill?: string; budget?: number; includeSoft?: boolean }) => ResolveResult;
}

const USAGE_RETENTION = 100;
let previousInstrumentedAt: number | undefined;

// ponytail: approximate process-local correlation; resets on restart, conflates concurrent users under shared/HTTP deployment, and is not true session correlation.
function beginInstrumentation(): { startedAt: number; followUp: boolean } {
  const startedAt = performance.now();
  const followUp = previousInstrumentedAt !== undefined && startedAt - previousInstrumentedAt <= 300000;
  previousInstrumentedAt = startedAt;
  return { startedAt, followUp };
}

async function persistUsage(deps: ToolDeps, record: Record<string, unknown>): Promise<void> {
  try {
    if (!deps.store.writeSavings) return;
    const existing = deps.store.readSavings ? await deps.store.readSavings() : [];
    const records = Array.isArray(existing)
      ? existing
      : (existing && typeof existing === 'object' && Array.isArray((existing as any).records) ? (existing as any).records : []);
    await deps.store.writeSavings([...records, record].slice(-USAGE_RETENTION));
  } catch {
    // Usage persistence is best effort and must not affect tool behavior.
  }
}

function skillMatches(section: SkillSection, skill: string): boolean {
  return section.id === skill || section.manifestId === skill || section.manifestId?.split('::')[1] === skill;
}

async function sectionCandidates(deps: ToolDeps, phase?: string, skill?: string): Promise<{ sections?: SkillSection[]; error?: string }> {
  const index = await deps.store.readIndex();
  const all = [...(await deps.store.readSections(Object.keys(index))).values()];
  let candidates = all;
  if (skill) {
    candidates = all.filter(s => skillMatches(s, skill));
    if (candidates.length === 0) return { error: `skill "${skill}" not found in index` };
  }
  if (phase !== undefined) candidates = candidates.filter(s => s.class === 'phase');
  if (phase !== undefined) candidates = (deps.searchSections ?? defaultSearchSections)(candidates, phase);
  return { sections: candidates };
}

async function querySections(deps: ToolDeps, query: string, phase?: string, skill?: string): Promise<{ sections?: SkillSection[]; error?: string }> {
  const candidates = await sectionCandidates(deps, phase, skill);
  if (candidates.error) return candidates;
  return { sections: (deps.searchSections ?? defaultSearchSections)(candidates.sections!, query) };
}

function tokenSavings(result: ResolveResult, sections: SkillSection[], manifests: Record<string, SkillManifest>): { tokensLoaded: number; tokensWholeFile: number | null; savingsPct: number | null } {
  const tokensLoaded = result.sections.reduce((sum, s) => sum + (sections.find(x => x.id === s.id)?.tokenCount ?? 0), 0);
  const manifestIds = new Set(result.sections.map(s => sections.find(x => x.id === s.id)?.manifestId).filter((id): id is string => !!id));
  let whole = 0;
  for (const id of manifestIds) {
    const manifest = manifests[id];
    if (!manifest || !Number.isFinite(manifest.tokenCount) || manifest.tokenCount <= 0) return { tokensLoaded, tokensWholeFile: null, savingsPct: null };
    whole += manifest.tokenCount;
  }
  if (whole <= 0) return { tokensLoaded, tokensWholeFile: null, savingsPct: null };
  return { tokensLoaded, tokensWholeFile: whole, savingsPct: Math.max(0, Math.min(100, (1 - tokensLoaded / whole) * 100)) };
}

function jsonResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// Match legacy compiler conflict errors so they never block indexing.
// Track B now emits SkillConflictDiagnostic, but older compilers and test mocks
// may still produce errors with this prefix — filter them out when diagnostics exist.
const CONFLICT_ERROR_PREFIX = 'Skill conflict:';

function isConflictError(e: BoundaryError): boolean {
  return e.error.startsWith(CONFLICT_ERROR_PREFIX);
}

function formatErrors(errors: BoundaryError[]): { errors: string[] } {
  return { errors: errors.map(e => `${e.path}: ${e.error}`) };
}

function freshnessError(section: SkillSection): string | null {
  if (!section.sourcePath || !section.sourceHash || typeof section.mtimeMs !== 'number' || typeof section.size !== 'number') {
    return `section "${section.id}" source metadata missing; rerun index_skills`;
  }
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(section.sourcePath);
  } catch {
    return `section "${section.id}" source changed; rerun index_skills`;
  }
  if (stat.mtimeMs === section.mtimeMs && stat.size === section.size) return null;
  try {
    const content = readSourceFile(section.sourcePath);
    if (content === undefined) return `section "${section.id}" source changed; rerun index_skills`;
    return computeHash(content) === section.sourceHash ? null : `section "${section.id}" source changed; rerun index_skills`;
  } catch {
    return `section "${section.id}" source changed; rerun index_skills`;
  }
}

function staleErrors(sections: Iterable<SkillSection>): string[] {
  return [...sections].map(freshnessError).filter((e): e is string => e !== null);
}

// ponytail: stale indexes remain usable through current whole-file source fallback.
function buildStaleResponse(staleSections: SkillSection[]): string {
  const manifestIds = [...new Set(staleSections.map(s => s.manifestId).filter((m): m is string => !!m))];
  return jsonResult({
    freshness: 'stale',
    rebuildRequired: {
      code: 'REBUILD_REQUIRED',
      action: 'index_skills',
      sectionIds: staleSections.map(s => s.id),
      ...(manifestIds.length > 0 ? { manifestIds } : {}),
      reason: 'source_changed'
    },
    content: staleSections
      .map(section => section.sourcePath ? readSourceFile(section.sourcePath) : undefined)
      .filter((content): content is string => content !== undefined)
      .join('\n\n')
  });
}

export async function handleIndexSkills(
  deps: ToolDeps,
  system: string,
  roots?: string[],
  baseDir?: string,
  force?: boolean
): Promise<string> {
  const workspaceRoot = baseDir ?? deps.resolveWorkspaceRoot();
  const homeDir = deps.resolveHomeDir();

  const ctx: DiscoveryContext = {
    workspaceRoot,
    repoRoot: null,
    homeDir,
    includeGlobals: true,
    includeSystem: false,
    explicitRoots: roots ?? [],
    explicitRootSystem: roots && roots.length > 0 ? system as DiscoveryContext['explicitRootSystem'] : undefined
  };

  if (force) {
    await deps.store.clear();
    await deps.store.writeIndex({});
  }

  const di = deps.discover(ctx);
  if (di.errors.length > 0) {
    return jsonResult(formatErrors(di.errors));
  }

  const requested = system;
  const artifacts = di.artifacts.filter(a => a.system === requested);
  const ni = deps.normalize(artifacts, ctx);
  if (ni.errors.length > 0) {
    return jsonResult(formatErrors(ni.errors));
  }

  const ci = deps.compile(ni.inputs, ctx);
  if (ci.errors.length > 0) {
    if (!ci.diagnostics || ci.diagnostics.length === 0) {
      // No diagnostics — errors are real compile errors, bail
      return jsonResult(formatErrors(ci.errors));
    }
    // Diagnostics present — filter legacy conflict errors; real errors still bail
    const nonConflict = ci.errors.filter(e => !isConflictError(e));
    if (nonConflict.length > 0) {
      return jsonResult(formatErrors(nonConflict));
    }
  }

  const compiled: Map<string, SkillSection> = ci.store instanceof Map
    ? ci.store
    : new Map(Object.entries(ci.store as Record<string, SkillSection>));

  const existingIndex = force ? {} : await deps.store.readIndex();
  const existingSections = force ? new Map<string, SkillSection>() : await deps.store.readSections(Object.keys(existingIndex));
  const store = new Map<string, SkillSection>();
  existingSections.forEach((section, id) => {
    if (section.system !== requested) store.set(id, section);
  });
  compiled.forEach((section, id) => store.set(id, section));

  await deps.store.writeSections(store);

  const indexEntries: Record<string, string> = {};
  store.forEach((section, id) => {
    indexEntries[id] = section.hash;
  });
  await deps.store.writeIndex(indexEntries);

  // ponytail: always prune manifests for the reindexed system so that
  // re-indexing to zero manifests properly removes stale persisted manifests.
  const existingManifests = force ? {} : await deps.store.readManifests();
  let manifestChanged = false;
  for (const id of Object.keys(existingManifests)) {
    if (existingManifests[id]!.system === requested) {
      delete existingManifests[id];
      manifestChanged = true;
    }
  }
  if (ci.manifests && ci.manifests.length > 0) {
    for (const manifest of ci.manifests) {
      existingManifests[manifest.id] = manifest;
      manifestChanged = true;
    }
  }
  if (manifestChanged) {
    await deps.store.writeManifests(existingManifests);
  }

  // pony tail: indexedSkills = manifest count (fallback distinct manifestId count from sections)
  const manifestCount = ci.manifests && ci.manifests.length > 0
    ? ci.manifests.length
    : new Set([...compiled.values()].map(s => s.manifestId || s.id)).size;

  const conflictCount = ci.diagnostics ? ci.diagnostics.length : 0;
  const displayErrors = ci.diagnostics && ci.diagnostics.length > 0
    ? ci.errors.filter(e => !isConflictError(e))
    : ci.errors;

  return jsonResult({
    indexedSkills: manifestCount,
    indexedSections: compiled.size,
    errors: displayErrors.map(e => `${e.path}: ${e.error}`),
    ...(conflictCount > 0 ? { conflictCount } : {}),
    ...(ci.diagnostics && ci.diagnostics.length > 0 ? { diagnostics: ci.diagnostics } : {})
  });
}

export async function handleListSkills(
  deps: ToolDeps,
  system?: string
): Promise<string> {
  const index = await deps.store.readIndex();
  const allIds = Object.keys(index);
  const sections = await deps.store.readSections(allIds);

  const relevant = system
    ? [...sections.values()].filter(s => s.system === system)
    : [...sections.values()];

  const errors = staleErrors(relevant);
  if (errors.length > 0) {
    const staleSections = relevant.filter(s => freshnessError(s) !== null);
    return buildStaleResponse(staleSections);
  }

  const manifests = await deps.store.readManifests();
  const manifestList = Object.values(manifests);

  // Filter candidate manifests by system (if requested) so system-scoped
  // list_skills only considers manifests for that system.
  const candidateManifests = system
    ? manifestList.filter(m => m.system === system)
    : manifestList;

  // Determine which manifests are truly live: must have at least one
  // indexed section whose section.manifestId === manifest.id (exact match,
  // same liveness contract as handleGetSkillManifest / handleGetSkillSections).
  const liveManifestIds = new Set<string>();
  for (const m of candidateManifests) {
    if (!m.sections || m.sections.length === 0) continue;
    const sectionIdsInIndex = m.sections.map(s => s.id).filter(id => id in index);
    if (sectionIdsInIndex.length === 0) continue;
    const sectionMap = await deps.store.readSections(sectionIdsInIndex);
    const matching = [...sectionMap.values()].filter(s => s.manifestId === m.id);
    if (matching.length > 0) liveManifestIds.add(m.id);
  }

  // ponytail: live persisted manifests → summaries
  const liveManifests = candidateManifests.filter(m => liveManifestIds.has(m.id));
  const manifestSkills = liveManifests.map(m => ({
    id: m.id,
    skillName: m.skillName || m.id,
    system: m.system,
    sectionCount: m.sections?.length ?? 0,
    tokenCount: m.tokenCount,
    byteLength: m.byteLength,
    kind: m.kind ?? null,
    description: m.description ?? null,
    precedence: m.precedence,
    conflictCount: m.conflicts ? m.conflicts.length : 0
  }));

  // ponytail: fallback for sections whose manifestId is not covered by any
  // live manifest (legacy sections, or manifestId not known to any persisted
  // manifest). Sections whose manifestId exists in persisted manifests but
  // the manifest is not live (stale/corrupt) are hidden, because get_* would
  // find the stale persisted manifest and reject it — list must not advertise
  // skills it cannot serve.
  const persistedManifestIds = new Set(Object.keys(manifests));
  const legacyRelevant = relevant.filter(s => {
    if (!s.manifestId) return true;
    if (liveManifestIds.has(s.manifestId)) return false;
    if (persistedManifestIds.has(s.manifestId)) return false;
    return true;
  });
  const distinctIds = [...new Set(legacyRelevant.map(s => s.manifestId || s.id))];
  const fallbackSkills = distinctIds.map(id => {
    const matching = legacyRelevant.filter(s => (s.manifestId || s.id) === id);
    const system = matching.find(s => s.system != null)?.system ?? null;
    const tokenCount = matching.reduce((sum, s) => sum + (typeof s.tokenCount === 'number' ? s.tokenCount : 0), 0);
    return { id, skillName: id, system, sectionCount: matching.length, tokenCount, kind: null, description: null };
  });

  const skills = [...manifestSkills, ...fallbackSkills];
  return jsonResult({ skills, count: skills.length });
}

export async function handleGetSkillManifest(
  deps: ToolDeps,
  skillId: string
): Promise<string> {
  const index = await deps.store.readIndex();
  const manifests = await deps.store.readManifests();

  // Try lookup by skillId directly in manifests
  const manifest = manifests[skillId];

  if (manifest) {
    // ponytail: liveness check uses exact manifest section IDs, not loose prefix scan
    const allSectionIds = Object.keys(index);
    const manifestSectionIds = manifest.sections.map(s => s.id);
    const matchingIds = manifestSectionIds.filter(id => id in index);
    if (matchingIds.length === 0) {
      return jsonResult({ errors: [`skill "${skillId}" not found in index`] });
    }
    const matchingSections = await deps.store.readSections(matchingIds);
    // Liveness: require section.manifestId === manifest.id (exact match)
    const liveSections = [...matchingSections.values()].filter(s => s.manifestId === manifest!.id);
    if (liveSections.length === 0) {
      return jsonResult({ errors: [`skill "${skillId}" not found in index`] });
    }
    const errors = staleErrors(liveSections);
    if (errors.length > 0) {
      const staleSections = liveSections.filter(s => freshnessError(s) !== null);
      return buildStaleResponse(staleSections);
    }

    // Return real manifest with backward-compat fields
    return jsonResult({
      skillId: manifest.id,
      hash: manifest.sourceHash,
      exists: true,
      id: manifest.id,
      skillName: manifest.skillName,
      system: manifest.system,
      kind: manifest.kind,
      description: manifest.description,
      sourcePath: manifest.sourcePath,
      sourceHash: manifest.sourceHash,
      tokenCount: manifest.tokenCount,
      byteLength: manifest.byteLength,
      precedence: manifest.precedence,
      conflicts: manifest.conflicts,
      sections: manifest.sections
    });
  }

  // ponytail: no manifest stored — match manifestId, fall back to section.id
  // for legacy sections that have no manifestId
  const allSections = await deps.store.readSections(Object.keys(index));
  const matches = [...allSections.values()].filter(s => s.manifestId === skillId || (!s.manifestId && s.id === skillId));
  if (matches.length === 0) return jsonResult({ errors: [`skill "${skillId}" not found in index`] });

  const errors3 = staleErrors(matches);
  if (errors3.length > 0) {
    const staleSections = matches.filter(s => freshnessError(s) !== null);
    return buildStaleResponse(staleSections);
  }
  const firstHash = index[matches[0]!.id] ?? matches[0]!.hash;

  // ponytail: backward compat — reconstruct partial manifest from sections
  return jsonResult({
    skillId,
    hash: firstHash,
    exists: true,
    sections: matches.map(section => ({
      id: section.id,
      title: section.title,
      class: section.class,
      tokenCount: section.tokenCount,
      byteLength: section.byteLength,
      references: section.references ?? [],
      policy: section.policy,
      order: section.order
    }))
  });
}

export async function handleGetSkillSections(
  deps: ToolDeps,
  skillId: string
): Promise<string> {
  const index = await deps.store.readIndex();
  const allIds = Object.keys(index);
  const manifests = await deps.store.readManifests();
  const manifest = manifests[skillId];

  if (manifest) {
    // ponytail: liveness uses exact manifest section IDs, not prefix scan
    const sectionIds = manifest.sections.map(s => s.id).filter(id => id in index);
    if (sectionIds.length === 0) {
      return jsonResult({ errors: [`skill "${skillId}" not found in index`] });
    }
    const sectionMap = await deps.store.readSections(sectionIds);
    // ponytail: consistency check — drop sections whose manifestId doesn't match
    const matches = sectionIds
      .map(id => sectionMap.get(id)!)
      .filter(s => s && s.manifestId === manifest.id);
    if (matches.length === 0) {
      return jsonResult({ errors: [`skill "${skillId}" not found in index`] });
    }
    const errors4 = staleErrors(matches);
    if (errors4.length > 0) {
      const staleSections = matches.filter(s => freshnessError(s) !== null);
      return buildStaleResponse(staleSections);
    }
    return jsonResult({ skillId, sections: matches });
  }

  // ponytail: no manifest stored — match manifestId, fall back to section.id
  // for legacy sections that have no manifestId
  const allSections = await deps.store.readSections(allIds);
  const matches = [...allSections.values()].filter(s => s.manifestId === skillId || (!s.manifestId && s.id === skillId));

  if (matches.length === 0) {
    return jsonResult({ errors: [`skill "${skillId}" not found in index`] });
  }

  const errors5 = staleErrors(matches);
  if (errors5.length > 0) {
    const staleSections = matches.filter(s => freshnessError(s) !== null);
    return buildStaleResponse(staleSections);
  }

  return jsonResult({ skillId, sections: matches });
}

export async function handleLoadSkillContext(
  deps: ToolDeps,
  query?: string,
  phase?: string,
  includeReferences?: boolean,
  maxBytes?: number
): Promise<string> {
  const index = await deps.store.readIndex();
  const allIds = Object.keys(index);

  if (allIds.length === 0) {
    return jsonResult({ errors: ['no skills indexed'] });
  }

  // Build a Record store from all sections for the retrieval layer
  const sectionsMap = await deps.store.readSections(allIds);
  const errors6 = staleErrors(sectionsMap.values());
  if (errors6.length > 0) {
    const staleSections = [...sectionsMap.values()].filter(s => freshnessError(s) !== null);
    return buildStaleResponse(staleSections);
  }
  const store: Record<string, SkillSection> = {};
  sectionsMap.forEach((s, id) => { store[id] = s; });

  try {
    // ponytail: progressive retrieval controls → request mode; plain string → backward compat
    const isRequestMode = phase !== undefined || includeReferences !== undefined || maxBytes !== undefined;
    let request: string | RetrievalRequest;
    if (isRequestMode) {
      request = { query, phase, includeReferences, maxBytes };
    } else if (query !== undefined) {
      request = query;
    } else {
      request = {}; // empty request mode — contract allows {}
    }
    const bundle = deps.loadContext(store, request);

    // Validate RetrievalBundle fields (contract: { sections, context })
    if (!Array.isArray(bundle.sections)) {
      return jsonResult({ errors: ['loadContext returned invalid sections'] });
    }
    if (typeof bundle.context !== 'string') {
      return jsonResult({ errors: ['loadContext returned invalid context'] });
    }

    return jsonResult({
      sectionCount: bundle.sections.length,
      content: bundle.context,
      sections: bundle.sections,
      references: bundle.references,
      omitted: bundle.omitted,
      totalBytes: bundle.totalBytes
    });
  } catch (err) {
    return jsonResult({ errors: [err instanceof Error ? err.message : String(err)] });
  }
}

export async function handleLoadSection(
  deps: ToolDeps,
  sectionId: string
): Promise<string> {
  // ponytail: check live index first so orphan section files not in index are rejected
  const index = await deps.store.readIndex();
  if (!(sectionId in index)) {
    return jsonResult({ errors: [`section "${sectionId}" not found in index`] });
  }

  const sections = await deps.store.readSections([sectionId]);
  const section = sections.get(sectionId);

  if (!section) {
    return jsonResult({ errors: [`section "${sectionId}" not found`] });
  }
  const errors7 = staleErrors([section]);
  if (errors7.length > 0) return buildStaleResponse([section]);

  // Extract wikilinks [[...]] and reuse extractMarkdownLinks for correct [label](url "title") parsing
  const wikiMatches = [...section.content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]!.trim());
  const mdTargets = extractMarkdownLinks(section.content);
  const allRefs = [...wikiMatches, ...mdTargets];

  const refs = new Map<string, number>();
  for (const ref of allRefs) {
    const count = refs.get(ref) ?? 0;
    refs.set(ref, count + 1);
  }

  const duplicateRefs: string[] = [];
  for (const [ref, count] of refs) {
    if (count > 1) duplicateRefs.push(`${ref} (${count}x)`);
  }

  return jsonResult({
    section,
    references: [...refs.keys()],
    duplicateRefs: duplicateRefs.length > 0 ? duplicateRefs : undefined,
    requires: section.requires ?? [],
    related: section.related ?? [],
    flowOf: section.flowOf ?? []
  });
}

export async function handleSearchSkillSections(deps: ToolDeps, query: string, phase?: string, skill?: string, k?: number): Promise<string> {
  const instrumentation = beginInstrumentation();
  let success = false;
  try {
    const result = await querySections(deps, query, phase, skill);
    if (result.error) return jsonResult({ errors: [result.error] });
    success = true;
    return jsonResult({ query, sections: result.sections!.slice(0, k ?? 10), count: Math.min(result.sections!.length, k ?? 10) });
  } finally {
    await persistUsage(deps, {
      timestamp: new Date().toISOString(), handler: 'search_skill_sections',
      latencyMs: performance.now() - instrumentation.startedAt, success, followUp: instrumentation.followUp
    });
  }
}

export async function handleResolveTaskSections(deps: ToolDeps, query: string, phase?: string, skill?: string, budget?: number, includeSoft?: boolean): Promise<string> {
  const instrumentation = beginInstrumentation();
  let success = false;
  let usageSavings: ReturnType<typeof tokenSavings> | undefined;
  let usageCollapsed: boolean | undefined;
  let usageMulti: boolean | undefined;
  try {
    const scoped = await sectionCandidates(deps, undefined, skill);
    if (scoped.error) return jsonResult({ errors: [scoped.error] });
    const found = await sectionCandidates(deps, phase);
    if (found.error) return jsonResult({ errors: [found.error] });
    const sections = found.sections!;
    const resolver = deps.resolve ?? defaultResolve;
    const result = resolver(sections, { query, skill, budget, ...(includeSoft === undefined ? {} : { includeSoft }) });
    const manifests = await deps.store.readManifests();
    const savings = tokenSavings(result, sections, manifests);
    usageSavings = savings;
    usageCollapsed = result.collapsed;
    usageMulti = result.sections.length > 1;
    success = true;
    return jsonResult({ ...result, tokenSavings: savings });
  } finally {
    await persistUsage(deps, {
      timestamp: new Date().toISOString(), handler: 'resolve_task_sections',
      latencyMs: performance.now() - instrumentation.startedAt, success, followUp: instrumentation.followUp,
      ...(usageSavings ? { tokenSavings: usageSavings, collapsed: usageCollapsed, multi: usageMulti } : {})
    });
  }
}

export async function handleDoctor(deps: ToolDeps): Promise<string> {
  const index = await deps.store.readIndex();
  const sections = await deps.store.readSections(Object.keys(index));
  const manifests = await deps.store.readManifests();
  return jsonResult(doctor(sections, manifests));
}
