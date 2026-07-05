# Track B Contract — Compiler + Retrieval

**Status:** Implemented contract. Owns parser, compiler, search, and retrieval.
Separate from Track A (discovery/normalization) and Track C (persistence/MCP).

## Public Entry Points

```typescript
// compiler
compile(inputs: NormalizedSkillInput[], ctx: DiscoveryContext): CompileResult

// retrieval
loadContext(store: SkillStore, queryOrRequest: string | RetrievalRequest): RetrievalBundle
```

**Internal / helper modules** (not public API surface — consumed by `compile`):

| Module | Role |
|---|---|
| `src/parser/markdown.ts` | Heading-based markdown parser; produces `ParsedMarkdown`. |
| `src/compiler/ids.ts` | Slug generation and collision-safe section ID synthesis. |
| `src/compiler/classify.ts` | Keyword-based heading → `SectionClass` classification. |
| `src/compiler/policy.ts` | Regex extraction of mandatory-policy lines. |
| `src/compiler/manifest.ts` | Section building and manifest assembly. |
| `src/search/lexical.ts` | Substring + multi-word scoring over `SkillSection[]`. |
| `src/retrieval/references.ts` | Markdown-link extraction and reference-kind classification. |

## Type Contracts

### SectionClass

```typescript
type SectionClass = 'always' | 'phase' | 'on_demand' | 'reference';
```

### SkillSection (enriched beyond base `id/title/content/hash`)

Adds: `system`, `sourcePath`, `sourceHash`, `mtimeMs`, `size`, `manifestId`, `class`, `policy`, `references`, `tokenCount`, `byteLength`, `order`.

### ReferenceRef / LoadedReference

```typescript
interface ReferenceRef {
  target: string;
  kind: 'file' | 'url' | 'skill';
  resolved?: boolean;
  absolutePath?: string;
  sourceRoot?: string;
}
interface LoadedReference { ref: ReferenceRef; content?: string; }
```

### ManifestSectionRef / SkillManifest

```typescript
interface ManifestSectionRef {
  id: string; title: string; class: SectionClass;
  tokenCount: number; byteLength: number;
  references: ReferenceRef[];
  policy?: MandatoryPolicy;
  order: number;
}
interface SkillManifest {
  id: string; skillName: string; system: SourceSystem;
  sourcePath: string; sourceHash: string;
  sections: ManifestSectionRef[];
  tokenCount: number; byteLength: number;
}
```

### RetrievalRequest / OmittedItem / RetrievalBundle

```typescript
interface RetrievalRequest {
  query?: string; phase?: string;
  includeReferences?: boolean; maxBytes?: number;
}
interface OmittedItem { id: string; reason: 'budget' | 'no_match' | 'reference_unresolved'; }
interface RetrievalBundle {
  sections: SkillSection[]; context: string;
  references?: LoadedReference[];
  omitted?: OmittedItem[]; totalBytes?: number;
}
```

### CompileResult

```typescript
interface CompileResult {
  store: SkillStore;          // Map<string, SkillSection>
  manifests?: SkillManifest[];
  errors: BoundaryError[];
}
```

## Manifest / ID Rules

- **Manifest ID:** `${system}::${skillName}::${sourceHash.slice(0, 8)}`
- **Section ID namespace:** `${manifestId}::${slugHeadingPath(headings)}`
  - `slugHeadingPath`: each heading lowercased, non-alphanumeric → `-`, collapsed, trimmed; joined with `--`.
- **Collision resolution** (global across all inputs via shared `seenIds` map):
  1. First collision → append `-<shortHash>` (first 8 hex of SHA-256 of content).
  2. Still collides → append stable counter `-2`, `-3`, … in encounter order.

## Compiler Behavior

- **Parse:** `parseMarkdown` splits on `#{1,6}` headings, ignoring headings inside fenced code blocks, and builds a nested `ParsedSection` tree with preamble captured as text before the first heading.
- **Preamble promotion:** Parser-discovered real headings control preamble promotion. When the parser finds at least one real heading, preamble text before the first heading is injected as a synthetic `Preamble` section (class `always` via keyword match). Fenced-code-only headings are ignored by the parser, so a document whose only headings appear inside fenced code blocks is treated as headingless — all content is wrapped in a synthetic `Instructions` section with no duplicate `Preamble`. Only when the parser finds zero real headings is the entire document wrapped in a single `Instructions` section.
- **Classify:** `classifyHeading` matches heading title against keyword map; default class is `phase`.
- **Policy extraction:** Lines matching `must|never|always|do not|required|security` (case-insensitive word boundary) → `MandatoryPolicy { lines, alwaysInclude: true }`.
- **Reference extraction:** Regex extracts markdown links; classified as `file` (default), `url` (`http(s)://`), or `skill` (`skill:` / `@skill/` prefix).
- **File reference resolution:** Resolved relative to source artifact directory; `realpathSync` applied; rejected if result escapes `sourceRoot`.
- **Token count:** Whitespace-split word count of `heading + '\n' + content`.
- **Byte length:** `Buffer.byteLength(content, 'utf-8')`.
- **Manifests:** One `SkillManifest` per input, aggregating section metadata.
- **Per-input errors:** Each input wrapped in try/catch; failure recorded as `{ path: input.sourcePath, error }`, batch continues.

## Retrieval Behavior

**Two modes:**

| Mode | Trigger | Empty-query behavior |
|---|---|---|
| Legacy (string) | `queryOrRequest: string` | Returns `{ sections: [], context: '' }` immediately. |
| Request | `queryOrRequest: RetrievalRequest` | Proceeds with selection; all sections are candidates. |

**Ordering** (always applied in this sequence):

1. **always** — sections with `class === 'always'` or `policy.alwaysInclude`.
2. **phase** — scored against `request.phase` if present, else against `query`.
3. **on_demand** — scored against `query` (only when query exists).
4. **references** — reference-class sections matched by `target` against picked section IDs/titles/sourcePaths; or all when `includeReferences` is set.

**Legacy fallback:** If no sections picked and a query exists, falls back to lexical search over all sections.

**Budget:** `maxBytes` enforced after selection. Mandatory sections (`always` / `policy.alwaysInclude`) are exempt. Non-mandatory sections exceeding remaining budget → omitted with reason `budget`.

**Omitted reasons:**
- `no_match` — on_demand/reference sections not picked when a query/phase/includeReferences was provided.
- `budget` — section or reference exceeded `maxBytes`.
- `reference_unresolved` — file ref disappeared or escaped source root at read time, or a metadata-only ref (url / skill) that is intentionally not loaded as content.

## Reference Safety

- **Filesystem file refs scoped to source artifact directory** — filesystem file refs are resolved relative to `dirname(sourcePath)`, not workspace/home/system roots.
- **No broad roots** — `resolveFileRefs` uses `realpathSync(sourceDir)` as `sourceRoot`; refs escaping it are marked `resolved: false`.
- **Index-first resolution** — at retrieval time, a reference target may be resolved to an already-indexed section (matched by `id`, `title`, or `sourcePath`) before any file loading occurs. Filesystem scoping rules above apply only when the reference falls through to an actual file read.
- **Re-realpath / revalidate before read** — `collectReferences` calls `realpathSync` again at retrieval time and re-checks against stored `sourceRoot` as a best-effort guard. This is not an atomic TOCTOU guarantee; a symlink swap between the realpath check and the file read is not fully caught.
- **One-hop only** — references resolve to a single file read; no recursive loading.
- **url / skill** — metadata-only; never fetched. Included in `LoadedReference` with `resolved` status but no `content`.

## MCP / Store Handoff Notes

- **Manifest IDs serve as skill IDs** downstream — `${system}::${skillName}::${hash8}` is the stable identifier persisted and exposed via MCP tools.
- **Persisted manifests** — `CompileResult.manifests` is the canonical list for Track C to serialize.
- **Index liveness gating** — Track C owns freshness checks. Stat changes (mtime/size) trigger hash verification against the stored `sourceHash`. A content-hash change invalidates and triggers a rebuild. Metadata-only stat changes (mtime/size differ but content hash is unchanged) leave the entry fresh — no rebuild.
- **Track C owns persistence format** — `SkillStore` is the handoff type; storage layout (file, DB, etc.) is Track C's concern.

## Validation Status

- `tsc` (build): passing.
- `vitest`: **253 tests passing** (16 test files).
- Tracks A, B, C all compile and test independently.
