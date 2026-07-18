# Ruleloom + Skillsect: Merged Architecture & Build Spec

**Status:** Build-ready spec  
**Extends:** Ruleloom's existing TypeScript codebase at `skill_usage_optimizer/`  
**Integrated from:** `sub-skill-search-design.md`, `sub-skill-search-implementation-plan.md`, `sub-skill-dependency-resolution.md`  

---

## Table of contents

1. [Architecture overview — three layers](#1-architecture-overview--three-layers)
2. [Layer 1 — Ingestion & Indexing (Ruleloom-derived)](#2-layer-1--ingestion--indexing-ruleloom-derived)
3. [Layer 2 — Dependency Resolution (skillsect-derived)](#3-layer-2--dependency-resolution-skillsect-derived)
4. [Layer 3 — Invocation & Integration (skillsect-derived)](#4-layer-3--invocation--integration-skillsect-derived)
5. [Merged section schema](#5-merged-section-schema)
6. [Resolved conflict — cross-source `requires` edges](#6-resolved-conflict--cross-source-requires-edges)
7. [Merged tool surface](#7-merged-tool-surface)
8. [Floor invariant — hard requirement](#8-floor-invariant--hard-requirement)
9. [Phased build order](#9-phased-build-order)
10. [Open questions](#10-open-questions)

---

## 1. Architecture overview — three layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LAYER 3 — Invocation & Integration                │
│  (skillsect-derived: CLI, MCP resolve_task_sections, Native hooks)  │
│  Runs dependency resolution on Layer 2's closure, returns bundles   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                    LAYER 2 — Dependency Resolution                    │
│  (skillsect-derived: requires/related edges, flows, budget valve,    │
│   collapse-to-whole-file, topological sort, progressive footer)      │
│  Operates on Layer 1's resolved (winner-only) section graph          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────────┐
│                    LAYER 1 — Ingestion & Indexing                     │
│  (Ruleloom-derived: multi-system discovery, precedence resolution,   │
│   compiler pipeline, freshness, on-disk store, BM25-lite search)     │
└──────────────────────────────────────────────────────────────────────┘
```

**Which existing code each layer maps to:**

| Layer | Origin | Existing code location |
|-------|--------|----------------------|
| Layer 1 — Ingestion & Indexing | Ruleloom | `src/discovery/`, `src/normalize/`, `src/parser/`, `src/compiler/`, `src/store/`, `src/search/lexical.ts` |
| Layer 2 — Dependency Resolution | skillsect (your design) | No existing code — new module `src/resolver/` |
| Layer 3 — Invocation & Integration | skillsect (your design) | Extends `src/mcp/tools.ts`, adds CLI entry point |

---

## 2. Layer 1 — Ingestion & Indexing (Ruleloom-derived)

Adopt Ruleloom's existing code as-is. No changes to the discovery, normalization, parser, compiler, classifier, store, or BM25-lite search unless a merge-specific issue is flagged in this document.

### What's carried forward intact

| Component | File | Status |
|-----------|------|--------|
| Discovery adapters (6 systems) | `src/discovery/*.ts` | Adopt as-is |
| Normalizer | `src/normalize/index.ts` | Adopt as-is |
| Fence-aware markdown parser | `src/parser/markdown.ts` | Adopt as-is |
| Heading classifier (always/phase/on_demand/reference) | `src/compiler/classify.ts` | Adopt as-is |
| Policy extraction | `src/compiler/policy.ts` | Adopt as-is |
| Manifest builder | `src/compiler/manifest.ts` | Adopt as-is |
| Precedence conflict resolution | `src/compiler/index.ts` | Adopt as-is |
| Deterministic ID generation | `src/compiler/ids.ts` | Adopt as-is |
| Content-hash staleness detection | `src/store/fileStore.ts`, `src/mcp/tools.ts` | Adopt as-is |
| BM25-lite lexical search | `src/search/lexical.ts` | Adopt as-is |
| Reference extraction + resolution | `src/retrieval/references.ts` | Adopt as-is |
| Retrieval context builder | `src/retrieval/context.ts` | Adopt as-is |
| On-disk store (.skill-cache/) | `src/store/fileStore.ts` | Adopt as-is |
| MCP server lifecycle | `src/mcp/server.ts` | Adopt as-is |
| Contract types | `src/types.ts`, `docs/contracts.md` | Adopt as-is |

### Merge-specific additions to Layer 1

1. **Section storage must carry `requires`, `related`, `provides`, `uses`, `flow_of`** — these are new fields on `SkillSection` (see merged schema, §5). They are populated by the section author as HTML comments or auto-inferred at index time.

2. **New `symbols.json` sidecar** (skillsect dependency-resolution design §9). Stored alongside `.skill-cache/sections/`. Contains `symbol → { defined_in, used_in }` for auto-inference of `requires`/`related` edges from shared code symbols.

3. **BM25F upgrade** (skillsect implementation-plan §5.1). Replace Ruleloom's flat BM25-lite (`src/search/lexical.ts`) with field-weighted BM25F. The weights below are **untuned starting defaults** — see Phase P1 gate for the eval-set requirement that validates or retunes them:

   - `heading_path`: 3.0
   - `keywords` (incl. code identifiers): 2.5
   - `skill_name`: 1.5
   - `summary`: 1.5
   - `body_head` (first ~200 tokens): 0.5

4. **Code identifier extraction** (skillsect implementation-plan §4.4). New helper in `src/parser/` (or `src/search/`) that extracts function names, CLI flags, API calls from fenced code blocks. Populates section `keywords` and feeds the `provides`/`uses` symbol index.

### Framing verification

**Ruleloom's actual strength (verified from source):**
- Multi-system discovery across 6+ harnesses with correct precedence tiers
- Precedence-based conflict resolution with winner/shadowed diagnostics (implemented in `src/compiler/index.ts` lines 16-53)
- Content-hash staleness detection with hard `REBUILD_REQUIRED` refusal (implemented in `src/mcp/tools.ts` lines 43-81)
- Deterministic section classification by heading keywords
- BM25-lite search with title boost (not full BM25F)

**Your design's actual strength (verified from docs):**
- Within-file dependency resolution (`requires`/`related`/flows) — no equivalent in Ruleloom
- Token budget and collapse-to-whole-file safety valve — no equivalent in Ruleloom
- Field-weighted BM25F (vs Ruleloom's flat BM25-lite)
- Code symbol extraction for edge inference — no equivalent in Ruleloom
- Progressive footer ("N more related available") — no equivalent in Ruleloom
- Named multi-step flows — no equivalent in Ruleloom
- Floor invariant (every failure degrades gracefully) — Ruleloom refuses on staleness instead of degrading (see §8)

Both framings are confirmed accurate.

---

## 3. Layer 2 — Dependency Resolution (skillsect-derived)

New module `src/resolver/`. No existing Ruleloom code covers this.

### 3.1 Node types

- **Section** — a `SkillSection` from Layer 1's store.
- **Flow** — a named, ordered recipe that expands to a list of member sections. Stored in a new sidecar `flows.json` under `.skill-cache/`.

### 3.2 Edge types

| Edge | Hardness | Included by resolver | Carries order | Source |
|------|----------|---------------------|---------------|--------|
| `requires: string[]` | Hard | Always (transitive closure) | Yes (prerequisite-first) | Author-declared or auto-inferred (single-def + called symbol) |
| `related: [{id, weight}]` | Soft | Only if clears threshold AND fits budget | No | Author-declared, auto-inferred (soft by default), or usage-learned |
| `__preamble__` | Hard | Always, implicit on every section | First | Injected by parser, always present |

### 3.3 Resolution algorithm

```typescript
function resolve(request: ResolveRequest, store: SkillStore): ResolveResult {
  // 1. Search across all sources with precedence applied — Layer 1's store
  //    already contains only winner sections, so this is safe.
  const seeds = searchSections(store, request.query, request.k ?? 1);

  // 2. If top seed is a flow, short-circuit
  if (seeds[0] && isFlow(seeds[0].id)) {
    return expandFlow(seeds[0].id, store, request);
  }

  // 3. Hard closure — transitive requires (prevents under-retrieval)
  const hard = new Map<string, SkillSection>();
  for (const seed of seeds) {
    transitiveRequires(seed, store, hard); // includes __preamble__
  }

  // 4. Collapse valve — if hard closure ≈ whole file, serve whole file
  if (shouldCollapse(hard, store, COLLAPSE_RATIO)) {
    return collapseToWholeFile(hard, store);
  }

  // 5. Soft expansion — budgeted, thresholded (prevents over-retrieval)
  const budget = request.budget ?? DEFAULT_BUDGET;
  const soft = expandRelated(hard, store, budget, SOFT_THRESHOLD);

  // 6. Topological sort — prerequisites first
  const ordered = topologicalSort(merge(hard, soft));

  // 7. Assemble bundle with progressive footer
  return {
    sections: ordered,
    leftovers: computeLeftovers(ordered, store, budget),
    collapsed: false,
    budget: { limit: budget, used: countTokens(ordered) }
  };
}
```

### 3.4 The four anti-over-retrieval valves

1. **Token budget** — hard ceiling on the entire bundle (default: `min(0.7 × whole_file_tokens, 2500)`).
2. **Collapse-to-whole-file** — if hard closure >= `COLLAPSE_RATIO` (0.7) of whole file tokens, load the whole file instead.
3. **Soft threshold** — only `related` sections with score >= `SOFT_THRESHOLD` (tuned on eval) are eligible.
4. **Progressive footer** — leftover related sections are named but not loaded; agent pulls them on demand.

### 3.5 Edge inference (at index time)

New inference step in `src/compiler/index.ts`, running after precedence resolution:

- **Cross-references:** intra-doc links and heading mentions → candidate `related` edges (soft).
- **Shared code symbols:** if section B's code *calls* a symbol *defined* in section A → candidate edge. Promote to `requires` (hard) only when the symbol has exactly one definition in the skill AND is actually called (not merely mentioned) in B.
- **Author always wins** over inference.

### 3.6 Flows

An author-declared flow short-circuits resolution entirely:

```markdown
<!-- flow: submit-form
     summary: Detect, fill, validate and submit a web form end to end
     steps: detect-fields, fill-fields, handle-validation, submit
-->
```

The flow is searchable (its name + summary + step summaries are indexed). On match, `resolve` returns the ordered members directly — no edge walking.

### 3.7 New types for `src/types.ts`

```typescript
export interface RelatedEdge {
  id: string;
  weight: number;
  source: 'author' | 'inferred' | 'learned';
}

export interface FlowNode {
  id: string;
  summary: string;
  steps: string[];          // ordered member section IDs
}

export interface ResolveRequest {
  query: string;
  phase?: string;           // passes through to Layer 1's search
  skill?: string;           // narrow search to one skill
  budget?: number;
  includeSoft?: boolean;    // default true
  k?: number;               // seeds to consider (default 1)
}

export interface ResolvedSection {
  id: string;
  headingPath: string[];
  content: string;
  role: 'hard' | 'soft';
  order: number;
  trustTier: string;
}

export interface ResolveResult {
  query: string;
  seed: string;
  matchedFlow?: string;
  collapsed: boolean;
  sections: ResolvedSection[];
  leftovers: string[];       // section IDs available but not loaded
  budget: { limit: number; used: number };
}
```

---

## 4. Layer 3 — Invocation & Integration (skillsect-derived)

### 4.1 CLI

New entry point `src/cli.ts`. Provides:

```
ruleloom index  [--system NAME] [--path DIR] [--force]
ruleloom search "<query>" [--skill NAME] [--k N] [--json]
ruleloom resolve "<query>" [--skill NAME] [--budget N] [--no-soft] [--json]
ruleloom get <skill>#<section> [--with-deps] [--no-preamble] [--raw]
ruleloom doctor            # validate graph, report cycles/dangling deps
ruleloom watch             # re-index on file save
ruleloom stats             # corpus size, section counts, conflict counts
```

### 4.2 MCP — merged tool surface

See §7 for the full reconciled tool list.

### 4.3 Native hook (deferred)

Identical to skillsect's Path C — intercept skill selection in Claude Code / OpenCode, substitute matched sections for the full file body. Only build after usage data shows the MCP round-trip is a bottleneck.

---

## 5. Merged section schema

One JSON shape. Ruleloom fields are marked **[R]**, skillsect fields **[S]**, merge-only fields **[M]**.

```typescript
interface MergedSkillSection {
  // --- Identity (R, extended by S) ---
  id: string;                          // [R] ruleloom::skillName::hash8::slug
  title: string;                       // [R] heading text
  headingPath: string[];               // [S] ancestor breadcrumb
  manifestId: string;                  // [R]

  // --- Content (R) ---
  content: string;                     // [R]
  hash: string;                        // [R] SHA-256 of content
  sourcePath: string;                  // [R]
  sourceHash: string;                  // [R]
  system: SourceSystem;                // [R]

  // --- Classification (R) ---
  class: SectionClass;                 // [R] always | phase | on_demand | reference
  policy?: MandatoryPolicy;            // [R]
  order: number;                       // [R] position in source file

  // --- Token/size (R) ---
  tokenCount: number;                  // [R]
  byteLength: number;                  // [R]

  // --- Precedence (R) ---
  precedence?: number;                 // [R]
  conflicts?: SkillConflictDiagnostic[]; // [R]

  // --- References (R) ---
  references: ReferenceRef[];          // [R]

  // --- Dependency resolution (S, NEW) ---
  requires: string[];                  // [S] hard dep section IDs (may cross skills)
  related: RelatedEdge[];              // [S] soft dep edges
  provides: string[];                  // [S] symbols defined in this section
  uses: string[];                      // [S] symbols called in this section
  flowOf: string[];                    // [S] flows this section belongs to

  // --- Summarization (S) ---
  summary: string;                     // [S] first sentence or author override
  keywords: string[];                  // [S] heading tokens + code identifiers

  // --- Addressing (S) ---
  lineRange: [number, number];         // [S] hint only; validated by content hash
  startAnchor: { text: string; level: number };  // [S]
  contentSha256: string;               // [S] duplicate of hash for clarity

  // --- Flags (S) ---
  oversized: boolean;                  // [S] true if exceeds max_section_tokens
}

// New sidecar files
interface SymbolsIndex {
  [symbol: string]: {
    definedIn: string;         // section ID
    usedIn: string[];          // section IDs
  };
}

interface FlowsIndex {
  [flowId: string]: FlowNode;
}
```

---

## 6. Resolved conflict — cross-source `requires` edges

### The conflict

The signature merge tension: what happens when a `requires` edge points from a winner section to a section that only exists in a **shadowed** (lower-precedence) source?

Example:
- Workspace `chrome/SKILL.md` (precedence 100, winner) section `submit` has `requires: ["detect-fields"]`
- But `detect-fields` only exists in `~/.config/opencode/skills/chrome/SKILL.md` (precedence 40, shadowed)

### Rule

**Precedence resolves first; the closure only ever sees the winning version of each section.** A hard dependency CANNOT reach into a shadowed source deliberately.

**Justification:** Precedence is the global arbitration mechanism. If `requires` could bypass it, a skill author could create a backdoor around the entire conflict-resolution system — effectively promoting a shadowed source to winner by referencing it from a winner. This violates the determinism contract that both designs rely on.

### What happens on violation (dangling `requires` target)

The resolver **gracefully skips** the missing (shadowed) section and **flags it via `doctor`**, NOT as a hard error:

```json
// resolve output when a requires target is missing:
{
  "query": "fill and submit the form",
  "seed": "chrome::submit",
  "sections": [ /* only available hard deps */ ],
  "warnings": [
    {
      "type": "dangling_requires",
      "sourceSection": "chrome::submit",
      "targetId": "detect-fields",
      "reason": "target not found in winner sources (exists only in shadowed source: opencode::chrome)"
    }
  ],
  "leftovers": ["detect-fields"],
  "collapsed": false
}
```

The floor invariant (see §8) applies: if the hard closure is empty or critically incomplete because of the dangling dep, the system falls back to whole-file load of the winner source.

### `doctor` command

New diagnostic command that validates the graph:

```
ruleloom doctor
```

Reports:
- Dangling `requires` targets (found in no winner source)
- Cycles in hard deps (mutual `requires` — promotes to co-required group, flagged)
- Cross-trust edges (an untrusted skill requiring from a project skill)
- Shadowed sections that are still referenced by winner sections

Each issue is a diagnostic, not a hard error. The system degrades gracefully.

---

## 7. Merged tool surface

### 7.1 MCP tools

Reconciled from both designs. Where they overlap, the Ruleloom name wins (it's already implemented). The skillsect name is listed as a secondary alias where useful.

| Tool | Origin | Status |
|------|--------|--------|
| `index_skills` | Ruleloom (adopt as-is) | Existing |
| `list_skills` | Ruleloom (adopt as-is) | Existing |
| `get_skill_manifest` | Ruleloom (adopt as-is) | Existing |
| `get_skill_sections` | Ruleloom (adopt as-is) | Existing |
| `load_skill_context` | Ruleloom (adopt, extend with phase filter) | Existing, extended |
| `load_section` | Ruleloom (adopt as-is) | Existing |
| `search_skill_sections` | Skillsect (new) | **NEW** — BM25F search across all sections, returns ranked pointers |
| `resolve_task_sections` | Merge-only (new) | **NEW** — search + dependency resolution in one call |
| `doctor` | Skillsect (new) | **NEW** — validate graph, report issues |

### 7.2 `search_skill_sections` — new tool

BM25F search across all indexed sections (extending Ruleloom's flat BM25-lite). Returns pointers only, not content.

```
search_skill_sections(query, skill?, k?, minScore?, phase?)
  → { results: [{ skill, section_id, heading_path, summary, score, confidence }], low_confidence: bool }
```

### 7.3 `resolve_task_sections` — the merged tool

This is the one new tool that exists only because of the merge. It:
1. Searches across all sources with precedence applied (Layer 1)
2. Runs dependency resolution on the winning section(s) (Layer 2)
3. Returns the ordered, budgeted bundle (Layer 3)

```
resolve_task_sections(query, phase?, skill?, budget?, includeSoft?)
  → {
      query: string,
      seed: string,
      matched_flow?: string,
      collapsed: boolean,
      sections: [{ id, heading_path, content, role, order, trust_tier }],
      leftovers: string[],
      budget: { limit, used },
      warnings?: DanglingDep[]
    }
```

### 7.4 CLI surface

Merged from both designs. `skillsect` renamed to `ruleloom` for consistency with the existing codebase (the Ruleloom CLI binary is `src/cli.ts`):

```
ruleloom index  [--system NAME] [--path DIR] [--force]
ruleloom search "<query>" [--skill NAME] [--k N] [--min-score S] [--json]
ruleloom resolve "<query>" [--skill NAME] [--budget N] [--no-soft] [--json]
ruleloom get <skill>#<section> [--with-deps] [--no-preamble] [--raw]
ruleloom doctor
ruleloom watch  [--path DIR]
ruleloom stats
```

### 7.5 Removed duplicates

| Skillsect name | Ruleloom winner | Rationale |
|----------------|-----------------|-----------|
| `skillsect search` | `ruleloom search` (uses BM25F) | Ruleloom codebase conventions |
| `skillsect get` | `load_section` MCP tool, `ruleloom get` CLI | MCP name kept from Ruleloom, CLI alias added |
| `skillsect index` | `index_skills` MCP tool, `ruleloom index` CLI | Same |
| `skillsect resolve` | `resolve_task_sections` MCP tool | Skillsect's resolve is now a merged tool (was CLI-only in both) |

---

## 8. Floor invariant — hard requirement

Every fallback path must degrade to at least current whole-file-load behavior. Never worse.

### Applicable scenarios

| Scenario | Floor behavior | Implementation |
|----------|---------------|----------------|
| **Stale index** (source changed since index) | **Fall back to whole-file read**, do NOT refuse | **Change from Ruleloom's current behavior**: Ruleloom currently returns `REBUILD_REQUIRED` and refuses to serve. In the merged system, `REBUILD_REQUIRED` is a warning, not a hard block. The read path attempts a whole-file read of the source `SKILL.md` as a fallback. Call `index_skills` asynchronously in the background. |
| **Dangling `requires`** | Serve available sections; flag in warnings | See §6 |
| **Empty search results** (no BM25F match above floor) | Return `low_confidence: true` with instruction to load full skill | Skillsect's confidence floor, already in Ruleloom's `confidence_floor` knob |
| **Ambiguous precedence** (tie with same precedence) | Winner picked deterministically; shadowed sources listed in diagnostics | Already implemented in Ruleloom |
| **Budget exhausted** | Return what fits; note omitted sections in footer | Already implemented in Ruleloom (`omitted` array) |
| **Corrupt or missing cache** | Re-index on demand, fall back to whole-file read if re-index fails | New behavior: try `index_skills` silently, serve from source file if it fails |

### Specific change to Ruleloom's `rebuildRequired`

**Current Ruleloom behavior** (from `src/mcp/tools.ts` lines 43-81): When a source file's mtime/size/hash doesn't match the cached value, Ruleloom hard-refuses with:

```json
{ "errors": ["section \"X\" source changed; rerun index_skills"], "rebuildRequired": { ... } }
```

**Merged behavior:** This is changed to degrade gracefully:

```json
{
  "errors": ["section \"X\" source changed; re-indexing in background, serving from source file"],
  "warning": "stale_index",
  "content": "<whole-file content read directly from source SKILL.md>",
  "rebuildRequired": { ... }
}
```

The agent gets the data it needs (the whole file) while `index_skills` runs asynchronously. The floor is maintained. **Justification:** A hard refusal violates the floor invariant. The user's task cannot be blocked by a stale cache. Determinism is important, but availability is more important. The stale warning gives the agent enough information to make a judgment call.

---

## 9. Phased build order

Extends Ruleloom's existing Track A/B/C structure (from `docs/parallel-implementation-tracks.md`) and skillsect's M0-M5 phase table. Overlap is consolidated.

### Phase P0 — Schema reconciliation (NEW, merge-only)

**Work:** Extend `src/types.ts` with merged section fields. Create `src/resolver/types.ts` for new types.

**Existing code adopted:** Ruleloom's `types.ts` is extended, not replaced.

**Files:**
- `src/types.ts` — add `requires`, `related`, `provides`, `uses`, `flowOf`, `summary`, `keywords`, `lineRange`, `startAnchor`, `contentSha256`, `oversized`, `RelatedEdge`, `FlowNode`, `ResolveRequest`, `ResolvedSection`, `ResolveResult`
- `src/resolver/types.ts` — new
- `docs/contracts.md` — update with new types

**Gate:** All existing tests pass unchanged.

---

### Phase P1 — BM25F + symbol extraction (extends Ruleloom's search)

**Work:** 
- Replace `src/search/lexical.ts` BM25-lite with field-weighted BM25F
- Add code identifier extraction from fenced blocks
- Add `provides`/`uses` extraction to `src/compiler/manifest.ts`

**Existing code adopted as-is:** Everything else in Layer 1.

**Files to change:**
- `src/search/lexical.ts` — BM25F upgrade
- `src/parser/markdown.ts` — add code identifier extraction helper
- `src/compiler/manifest.ts` — populate `provides`, `uses`, `keywords`

**New files:**
- `src/search/identifiers.ts` — code identifier extraction

**Gate:** precision@3 >= 0.8 on a curated eval set. Phase P1 is blocked until this eval set exists.

**Eval set requirement (must exist before P1 can begin):**
- Minimum 20 task-query × skill pairs (e.g. "log into the portal in Chrome" → expected section `chrome#login`).
- Queries must target at least 3 different multi-section skills with >= 4 sections each.
- Each entry is a JSON record: `{ query, skill, expectedSectionIds: string[], notes?: string }`.
- Stored at `tests/fixtures/eval/queries.json`.
- Submissions from both synthetic (auto-generated from heading text) and real (hand-labeled from task histories) queries. Aim for a 50/50 split.

The target of 0.8 is provisional. It may be adjusted after the first 20 entries, but the adjustment must be documented and the original data retained.

**BM25F field weights note:** The weights below (`heading_path: 3.0`, `keywords: 2.5`, etc.) are **untuned starting defaults** carried forward from the original skillsect design doc, not derived from Ruleloom's actual corpus. The Phase P1 implementer is responsible for validating or retuning these weights against the eval set. The final weights must be documented in `src/search/lexical.ts` as a constant at the top of the file, with a comment noting which eval run produced them.

---

### Phase P2 — Dependency resolver (port skillsect's logic)

**Work:** Implement `src/resolver/` as a new module. All new code — no existing Ruleloom code to modify.

**Files:**
- `src/resolver/index.ts` — resolve algorithm (§3.3)
- `src/resolver/graph.ts` — transitive closure, topological sort, cycle detection
- `src/resolver/edges.ts` — edge inference from cross-refs + symbols
- `src/resolver/flows.ts` — flow expansion
- `src/resolver/budget.ts` — budget tracking, collapse valve

**Tasks:**
1. Transitive closure + topo sort for `requires` edges (hard)
2. Collapse-to-whole-file valve
3. Soft expansion with budget + threshold
4. Progressive footer computation
5. Flow short-circuit
6. Edge inference (cross-ref + symbol def/use)
7. Cycle detection + co-required groups

**Gate:** Dependency recall = 1.0 on authored eval skills; over-retrieval ratio near 1.0.

---

### Phase P3 — Merge MCP tools (new + extended)

**Work:**
- Add `search_skill_sections` MCP tool (= BM25F search)
- Add `resolve_task_sections` MCP tool (= search + resolve)
- Add `doctor` MCP tool (= graph validation)
- Extend `load_skill_context` with `phase` filter (already partially supported)
- Extend `load_section` response with dependency metadata

**Files to change:**
- `src/mcp/tools.ts` — add handlers
- `src/mcp/schemas.ts` — add input/output schemas
- `src/mcp/server.ts` — register new tools

**Files to keep unchanged:**
- `index_skills`, `list_skills`, `get_skill_manifest`, `get_skill_sections`, `load_section` — adopt as-is

**Gate:** Parity between CLI and MCP results.

---

### Phase P4 — `rebuildRequired` floor fix (changes Ruleloom behavior)

**Work:** Change `src/mcp/tools.ts` staleness handling to degrade to whole-file read instead of refusing.

**Files to change:**
- `src/mcp/tools.ts` — `staleErrors()` → attempt source file read; `buildStaleResponse()` → include fallback content
- `src/fs/freshness.ts` — add `readSourceFile` helper

**Gate:** All read tools return content even when cache is stale (with warning), never hard-refuse.

---

### Phase P5 — CLI (new entry point)

**Work:** Create `src/cli.ts` as a thin shell over the core library + resolver.

**Files:**
- `src/cli.ts` — command dispatcher
- `package.json` — add `bin` entry

**Gate:** CLI commands produce identical output to MCP tool responses for the same inputs.

---

### Phase P6 — `doctor` command (new)

**Work:** Implement graph validation: cycles, dangling deps, cross-trust edges, oversized sections.

**Files:**
- `src/resolver/doctor.ts` — validation logic
- Wired into CLI (`ruleloom doctor`) and MCP (`doctor` tool)

**Gate:** All diagnostics are surfaced as warnings, never hard errors.

---

### Phase P7 — Flows (conditional)

**Work:** Author-declared flow support: parsing, indexing, short-circuit resolution.

**Files:**
- `src/parser/flow.ts` — extract `<!-- flow: ... -->` annotations
- `src/resolver/flows.ts` — already scaffolded in P2, fill in short-circuit + expansion

**Gate:** "Workflow" queries resolve to the correct ordered members.

---

### Phase P8 — Learned edges (conditional, deferred)

**Work:** Co-load telemetry strengthens `related` weights. Only if P1-P7 miss-rate warrants it.

**Files:**
- `src/resolver/learned.ts` — co-occurrence tracking
- Local-only log files (never uploaded)

**Gate:** Only if measured dependency recall < 1.0 after P2.

---

### Phase P9 — Native hooks (deferred, conditional)

Per skillsect's Path C. Identical scope. Only if MCP round-trip is a proven bottleneck.

---

## 10. Open questions

1. **Cross-trust hard dependencies — resolved as a security boundary, not a retrieval-quality question.**

   The existing dependency-resolution design (§8 of `sub-skill-dependency-resolution.md`) already establishes that cross-skill hard edges are author-only, inherit the lower trust tier, and are envelope-wrapped. This is a good foundation, but it misses a critical asymmetry: the direction of the edge changes the risk model.

   **Two distinct cases, two different rules:**

   | Direction | Example | Risk | Rule |
   |-----------|---------|------|------|
   | **Lower → Higher trust** (e.g. `marketplace#section requires: project#dep`) | An untrusted skill author places a `requires` on a trusted section | **Control-flow attack** — the resolver automatically pulls trusted content at the direction of an untrusted source, without the agent's awareness or consent. The trusted section is authentic, but the *act of selecting it* is controlled by an untrusted party. | **Block automatic resolution.** The `requires` edge is demoted to `related` (soft) automatically, preserving the original weight. It will not load automatically unless the agent explicitly calls for it. |
   | **Higher → Lower trust** (e.g. `project#section requires: marketplace#dep`) | A trusted skill author consciously references an untrusted section | **Content-quality risk** — the pulled content may be wrong or malicious, but the *decision to pull it* was made by a trusted author. | **Allow automatic resolution**, but the pulled section inherits the lower trust tier and is envelope-wrapped as untrusted reference data (strictest wrapping: flagged `trust: 'untrusted'`, never treated as instruction). |

   **Rationale for blocking lower→higher hard edges:** This is not a retrieval-quality question. The floor invariant does not apply here — today's behavior is that an agent reads a skill file and *chooses* whether to follow a reference. The merged system automates that decision, which creates a new trust boundary. An untrusted skill using `requires` to force a trusted section into context without the agent's awareness is a structural security smell that should not be silently resolved.

   **`doctor` CI-blocking rule:** Lower→higher demotions are surfaced as a warning in the `doctor` output. The warning severity is `"error"` (not `"warn"`) — it is loud enough that a CI step checking `doctor` output will fail by default. Higher→lower edges are `"warn"` only, not CI-blocking (the trusted author chose the dependency — the risk is content quality, not control flow).

   **Implementation notes:**
   - The demotion happens at resolve time in `src/resolver/index.ts`, not at index time. The edge stays as `requires` in the stored section data; the resolver checks trust-tier directionality at the moment it builds the closure.
   - Trust tiers are drawn from the winner source's precedence mapping. Ruleloom's `DiscoveredArtifact.precedence` already carries this information — the resolver maps precedence values to tier labels (`precedence >= 200 → bundled`, `100-199 → project`, `50-99 → personal`, `10-49 → marketplace`, `0-9 → untrusted`).
   - The envelope-wrapping for allowed cross-trust edges: prepend `[untrusted reference — verify before acting]` to the content and strip the `class` field so it is never classified as `always`/mandatory.

2. **Collapse-to-whole-file when the skill crosses precedence boundaries.** If a winner skill is collapsed to whole-file because its hard closure is too large, but parts of the file were shadowed and dropped — the collapse loads only the winner's file body, which is correct. But the collapse message should note that shadowed sources existed.

3. **`__preamble__` is implicit; should it also be subject to precedence?** Currently any winner source's preamble is included. If a shadowed source had a critical safety preamble, it would be lost.

   This does **not** violate the floor invariant, for the following reason: the floor invariant says failures must degrade to *at least* today's whole-file-load behavior, never worse. Today, before this system exists, if two sources for the same logical skill exist in different locations (e.g. `.claude/skills/chrome/SKILL.md` and `~/.config/opencode/skills/chrome/SKILL.md`), the agent loads whichever one it encounters first. The other source's preamble is simply never included. The behavior is non-deterministic — whichever file the agent finds wins, the other is invisible.

   The merged system replaces that non-determinism with deterministic precedence-based selection. The *same outcome* occurs (one preamble applies, the other is dropped), but with three strict improvements:
   a. The selection is deterministic and reproducible (precedence tiebreak), not ambiguous.
   b. The shadowed source's existence is surfaced in `conflicts` diagnostics, so the author knows what was dropped.
   c. The `doctor` command explicitly flags shadowed preambles as advisory items, giving the author a path to notice and merge safety-critical preamble content into the winner source.

   Since today's behavior is "at most one preamble applies, silently," the merged system is strictly better — same availability, better transparency. No regression.

   **Recommendation:** Keep the current answer (winner's preamble only, doctor flag). Don't auto-merge shadowed preambles — that would violate the precedence boundary and create a silent merge of potentially contradictory safety instructions. Future work could add a `doctor --diff-preambles` option that surfaces textual differences.

4. **Symbol inference across skills.** Skillsect's design allows auto-inferred cross-skill edges but constrains them to soft-only with higher threshold. This is correct and adopted as-is. No change.

5. **`COLLAPSE_RATIO` and `SOFT_THRESHOLD` defaults.** Need empirical tuning against the eval set. Start with skillsect's defaults (`COLLAPSE_RATIO = 0.7`, `SOFT_THRESHOLD` tuned on eval, `budget = min(0.7 × whole_file, 2500)`).

6. **Flow searchability.** Flows are indexed in the BM25F corpus. Their `summary` and step summaries provide searchable text. But flows have no `heading_path` — what field weight do they get? **Recommendation:** treat `summary` as `heading_path` weight (3.0) for flows, since their summary is the author's intent signal.