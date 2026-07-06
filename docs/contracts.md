# Shared Contracts (Track A)

**Status:** Frozen for Track A with approved result-object revision (2026-07-04).

## Core Types

```typescript
export type SourceSystem = 'claude' | 'opencode' | 'codex' | 'copilot';

export type SectionClass = 'always' | 'phase' | 'on_demand' | 'reference';

export type ArtifactKind =
  | 'skill_package'
  | 'instruction_file'
  | 'rule_file'
  | 'convention_file'
  | 'pseudo_skill';

export interface DiscoveryContext {
  workspaceRoot: string;
  repoRoot: string | null;
  homeDir: string;
  includeGlobals: boolean;
  includeSystem: boolean;
  explicitRoots: string[];
  /** Attribute arbitrary explicit roots to this system; heuristic fallback still applies when absent. */
  explicitRootSystem?: SourceSystem;
  /** Test seam: override the Codex system skills directory. */
  codexSystemRoot?: string;
}

export interface DiscoveredArtifact {
  system: SourceSystem;
  kind: ArtifactKind;
  absolutePath: string;
  relativePath: string;
  rootOrigin: string;
  precedence: number;
  /** null unless discovery followed a config-file indirection. */
  configIndirection: string | null;
  rawStat: { mtimeMs: number; size: number };
}

export interface NormalizedSkillInput {
  system: SourceSystem;
  kind: ArtifactKind;
  skillName: string;
  description: string | null;
  rawMarkdown: string;
  frontmatter: Record<string, unknown>;
  attachments: string[];
  sourcePath: string;
  sourceHash: string;
  mtimeMs: number;
  size: number;
  precedence: number;
}

export interface SkillSourceRef {
  system: SourceSystem;
  sourcePath: string;
  sourceHash: string;
}

export interface SkillConflictDiagnostic {
  conflictKey: string;
  winner: SkillSourceRef;
  shadowed: SkillSourceRef[];
  reason: 'higher_precedence' | 'same_precedence_tiebreak';
  winnerPrecedence: number;
}
```

## Module API Boundaries

```typescript
// discovery
export function discover(ctx: DiscoveryContext): DiscoverResult;

// normalization
export function normalize(
  artifacts: DiscoveredArtifact[],
  ctx: DiscoveryContext
): NormalizeResult;

// compiler
export function compile(
  inputs: NormalizedSkillInput[],
  ctx: DiscoveryContext
): CompileResult;

// retrieval
export function loadContext(
  store: SkillStore,
  queryOrRequest: string | RetrievalRequest
): RetrievalBundle;
```

## SkillStore Contract

The compiler output (`SkillStore`) may be represented as either
`Map<string, SkillSection>` or `Record<string, SkillSection>`. Consumers
must accept either form. `loadContext` accepts both.

```typescript
export interface SkillSection {
  id: string;
  title: string;
  content: string;
  hash: string;
  system?: SourceSystem;
  sourcePath?: string;
  sourceHash?: string;
  mtimeMs?: number;
  size?: number;
  manifestId?: string;
  class?: SectionClass;
  policy?: MandatoryPolicy;
  references?: ReferenceRef[];
  tokenCount?: number;
  byteLength?: number;
  order?: number;
  precedence?: number;
}

export type SkillStore = Map<string, SkillSection> | Record<string, SkillSection>;

export interface MandatoryPolicy {
  lines: string[];
  alwaysInclude: boolean;
}

export interface ReferenceRef {
  target: string;
  kind: 'file' | 'url' | 'skill';
  resolved?: boolean;
  absolutePath?: string;
  sourceRoot?: string;
}

export interface LoadedReference {
  ref: ReferenceRef;
  content?: string;
}

export interface OmittedItem {
  id: string;
  reason: 'budget' | 'no_match' | 'reference_unresolved';
}

export interface RetrievalRequest {
  query?: string;
  phase?: string;
  includeReferences?: boolean;
  maxBytes?: number;
}

export interface ManifestSectionRef {
  id: string;
  title: string;
  class: SectionClass;
  tokenCount: number;
  byteLength: number;
  references: ReferenceRef[];
  policy?: MandatoryPolicy;
  order: number;
}

export interface SkillManifest {
  id: string;
  skillName: string;
  system: SourceSystem;
  kind: ArtifactKind;
  description: string | null;
  sourcePath: string;
  sourceHash: string;
  sections: ManifestSectionRef[];
  tokenCount: number;
  byteLength: number;
  precedence?: number;
  conflicts?: SkillConflictDiagnostic[];
}

export interface RetrievalBundle {
  sections: SkillSection[];
  context: string;
  references?: LoadedReference[];
  omitted?: OmittedItem[];
  totalBytes?: number;
}
```

## Stable ID Collision Resolution

When duplicate headings or body-hash collisions produce the same section ID,
the compiler applies a deterministic fallback:

1. First append `-<shortHash>` where `shortHash` is the first 8 hex chars of
   SHA-256(body).
2. If that still collides, append a stable numeric counter (`-2`, `-3`, …)
   in encounter order.

## Result Object Contracts

Cross-module functions that produce collections or may encounter errors
return a plain result object. Utility functions (e.g. `loadContext`) may
return values directly. No uncaught exceptions escape module boundaries.

```typescript
export type BoundaryError = { path: string; error: string };

export interface DiscoverResult {
  artifacts: DiscoveredArtifact[];
  errors: BoundaryError[];
}

export interface NormalizeResult {
  inputs: NormalizedSkillInput[];
  errors: BoundaryError[];
}

export interface CompileResult {
  store: SkillStore;
  errors: BoundaryError[];
  manifests?: SkillManifest[];
  diagnostics?: SkillConflictDiagnostic[];
}
```

- Errors inside a module are captured into the result's `errors` array.
- Callers inspect `errors` to decide whether to abort or continue.
- Empty `errors` means success; non-empty does not imply total failure — the
  result still contains whatever partial output was produced.
- Uncaught throws across a module boundary are a contract violation. Each
  module wraps its top-level entry point in a try/catch that converts
  unexpected errors into a `{ path: '<track>', error: string }` entry.

## Compile Conflicts Are Non-Fatal Diagnostics

When the compiler detects precedence conflicts between skill sources (e.g.,
two systems define the same skill name, or sections collide), these are
reported as `SkillConflictDiagnostic` entries in `CompileResult.diagnostics`,
**not** as `BoundaryError` entries in `CompileResult.errors`.

- A conflict does not prevent compilation; the compiler picks a winner by
  precedence (or deterministic tiebreak) and records the decision.
- `errors` remains reserved for hard failures (unreadable files, parse
  errors, unsafe paths).
- Consumers that need to surface conflicts to users read `diagnostics`, not
  `errors`.

**Migration responsibility (Track B):** If the current runtime still emits
conflicts as `BoundaryError` entries in `errors`, Track B must migrate
conflict reporting to `diagnostics` before claiming contract compliance.
This contract defines the target state; runtime parity is a Track B deliverable.

## Freezing Rules

1. A type or module signature in this document may not be altered by a
   single change.
2. Changes require updating this contract first, then updating dependents.
