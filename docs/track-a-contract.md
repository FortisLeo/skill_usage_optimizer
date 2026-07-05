# Track A — Discovery + Normalization Contract

Reference for the implemented Track A boundary. The authoritative type
definitions live in `src/types.ts` and `docs/contracts.md`; this file
summarizes behavior.

## Module API

```typescript
discover(ctx: DiscoveryContext): DiscoverResult
normalize(artifacts: DiscoveredArtifact[], ctx: DiscoveryContext): NormalizeResult
```

## `DiscoverResult`

```typescript
{ artifacts: DiscoveredArtifact[]; errors: BoundaryError[] }
```

- Runs four per-system discoverers (`claude`, `opencode`, `codex`, `copilot`)
  plus an optional explicit-roots scan when `ctx.explicitRoots` is non-empty.
- Each per-system discoverer is wrapped in its own try/catch; a failure in
  one system does not abort the others. Errors are recorded as
  `{ path: 'discover:<system>', error }`.
- Explicit-roots scan errors use `path: 'discover:explicitRoots'`; individual
  roots that fail the source-system heuristic emit
  `{ path: <root>, error: 'unknown explicit root source system: <root>' }`.
- An outer try/catch converts any unexpected throw into
  `{ path: 'discover', error }` and returns `{ artifacts: [], errors }`.
- Dedup by `absolutePath` — higher `precedence` wins.
- Final sort order: system → kind → `relativePath` (locale).

## `NormalizeResult`

```typescript
{ inputs: NormalizedSkillInput[]; errors: BoundaryError[] }
```

- Per-artifact try/catch. A read/parse failure on one artifact is recorded
  against its `absolutePath` and does not abort the batch.
- Path-safety check via `isPathSafe(absolutePath, allowedRoots)` runs before
  any read; unsafe paths emit an error and are skipped.
- Outer try/catch converts unexpected throws into
  `{ path: 'normalize', error }` with `inputs: []`.

## `NormalizedSkillInput`

| Field | Semantics |
|---|---|
| `system`, `kind` | Carried from the artifact. |
| `skillName` | `skill_package`: parent directory name. Other kinds: filename minus extension. |
| `description` | Frontmatter `description` if non-empty string; else first non-heading, non-empty body line; else `null`. |
| `rawMarkdown` | **Full normalized file content** (BOM stripped, CRLF/CR → LF), including frontmatter. Not just the body. |
| `frontmatter` | Parsed YAML frontmatter; `{}` when no `---` fence. Malformed fence (opening `---\n` with no closing `---`) throws, captured as a per-artifact error. |
| `attachments` | From frontmatter `attachments` — array pass-through, comma-split string, or `[]`. |
| `sourcePath` | Absolute path of the source file. |
| `sourceHash` | SHA-256 hex of the **normalized content** (same bytes as `rawMarkdown`). |
| `mtimeMs` | Fresh `statSync` at normalize time — not the discovery-time `rawStat.mtimeMs`. |
| `size` | Fresh `statSync` at normalize time — not the discovery-time `rawStat.size`. |
| `precedence` | Carried from the artifact. |

`rawStat` on the artifact captures discovery-time metadata; the normalized
input re-stats to get authoritative freshness for downstream invalidation.

## `explicitRootSystem`

Optional `DiscoveryContext.explicitRootSystem: SourceSystem` overrides the
path-based heuristic (`sourceSystemFromRoot`) for every explicit root. When
absent, the heuristic still applies; if neither resolves, the root is
skipped with an `unknown explicit root source system` error.

## Freshness metadata

- `computeHash` = SHA-256 of normalized content (`normalizeContent`: strip
  BOM, `CRLF`/`CR` → `LF`).
- `isStale` compares `{ hash, mtimeMs, size }` — any field differing means
  stale.
- Discovery captures `rawStat` once; normalize re-stats to produce the
  canonical `mtimeMs` / `size` on `NormalizedSkillInput`.

## Boundary error behavior

- No uncaught throws escape `discover` or `normalize`. Each module's
  top-level entry point is wrapped in try/catch.
- Empty `errors` = success. Non-empty `errors` ≠ total failure — the result
  still contains whatever partial output was produced before the error.
- Per-item errors are recorded against the offending path; the batch
  continues.
- An unexpected throw at the outer level returns `{ artifacts|inputs: [],
  errors: [{ path: '<track>', error }] }`.
