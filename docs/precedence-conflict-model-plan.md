# Precedence & Conflict Model — Implementation Plan

## Goal

Decide which duplicate/overlapping instruction source wins when multiple
skills/rules apply to the same effective identity. Prevent wrong, global,
stale, or duplicate rules from all loading together. Provide diagnostics for
shadowed sources so users can see *why* a skill won or lost.

## Thesis

Ship the **minimal deterministic model first**. No ML, no RAG, no semantic
contradiction detection. A deterministic sort + group is enough to resolve the
real bug (duplicates co-loading) and gives us a clean surface to extend later
if we ever need it.

## Scope

In scope:

- Resolve conflicts between `NormalizedSkillInput`s that share the same
  effective identity.
- Compile only the winner per identity.
- Persist and expose diagnostics for shadowed inputs.

Out of scope (explicitly):

- Semantic contradictions inside markdown bodies.
- Merging sections from multiple skills.
- Cross-system equivalence (e.g. "ponytail" in two registries meaning the
  same thing).
- ML/LLM ranking or embedding-based resolution.

## Existing Precedence Flow (Do Not Touch Unless Buggy)

```
DiscoveredArtifact.precedence
        │
        ▼
NormalizedSkillInput.precedence
        │
        ▼
(compiler — currently no resolution)
```

Track A's job is to propagate precedence metadata faithfully. This plan does
**not** change Track A unless a precedence-propagation bug surfaces during
implementation.

## Data Model Additions

New types in `src/types.ts`:

```ts
// Stable reference to the originating source of a skill input.
export interface SkillSourceRef {
  system: string;        // e.g. "opencode-registry", "local-workspace"
  sourcePath: string;    // artifact path or registry id
  sourceHash: string;    // content hash for tiebreak stability
}

// One row in the conflict diagnostic table.
export interface SkillConflictDiagnostic {
  conflictKey: string;
  winner: SkillSourceRef;
  shadowed: SkillSourceRef[];
  reason: "higher_precedence" | "same_precedence_tiebreak";
  winnerPrecedence: number;
}
```

Optional fields (additive, non-breaking):

- `SkillManifest.conflictKey?: string`
- `SkillManifest.diagnostics?: SkillConflictDiagnostic[]`
- `SkillSection.conflictKey?: string`
- `CompileResult.conflictCount?: number`
- `CompileResult.diagnostics?: SkillConflictDiagnostic[]`

All optional so existing consumers keep working.

## Conflict Key

```
${input.system}::${input.skillName}
```

Same-name skills from **different systems** stay independent for now. This
keeps the model honest — we don't claim cross-system equivalence we can't
prove. Refine later if data demands it.

## Compiler Algorithm

Run inside the compiler after `NormalizedSkillInput[]` is built, before
section compilation:

```ts
function resolveConflicts(
  inputs: NormalizedSkillInput[]
): { winners: NormalSkillInput[]; diagnostics: SkillConflictDiagnostic[] } {
  const groups = new Map<string, NormalizedSkillInput[]>();
  for (const input of inputs) {
    const key = `${input.system}::${input.skillName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(input);
  }

  const winners: NormalizedSkillInput[] = [];
  const diagnostics: SkillConflictDiagnostic[] = [];

  for (const [key, group] of groups) {
    // Deterministic sort: precedence DESC, sourcePath ASC, sourceHash ASC.
    const sorted = [...group].sort((a, b) => {
      if (a.precedence !== b.precedence) return b.precedence - a.precedence;
      if (a.source.sourcePath !== b.source.sourcePath)
        return a.source.sourcePath.localeCompare(b.source.sourcePath);
      return a.source.sourceHash.localeCompare(b.source.sourceHash);
    });

    const [winner, ...shadowed] = sorted;
    winners.push(winner);

    if (shadowed.length > 0) {
      diagnostics.push({
        conflictKey: key,
        winner: winner.source,
        shadowed: shadowed.map((s) => s.source),
        reason:
          winner.precedence === shadowed[0].precedence
            ? "same_precedence_tiebreak"
            : "higher_precedence",
        winnerPrecedence: winner.precedence,
      });
    }
  }

  return { winners, diagnostics };
}
```

Only `winners` proceed to section compilation. Shadowed inputs are dropped
but recorded.

## Diagnostics Example

```json
{
  "conflictKey": "opencode-registry::ponytail",
  "winner": {
    "system": "opencode-registry",
    "sourcePath": "registry/ponytail/SKILL.md",
    "sourceHash": "abc123"
  },
  "shadowed": [
    {
      "system": "opencode-registry",
      "sourcePath": "registry/ponytail-v2/SKILL.md",
      "sourceHash": "def456"
    }
  ],
  "reason": "higher_precedence",
  "winnerPrecedence": 100
}
```

## MCP Surface Changes

No new tool initially. Extend existing ones:

- `index_skills` response: add `conflictCount` and `diagnostics[]`.
- `list_skills` response: per-skill `precedence` and `conflictCount`.
- `get_skill_manifest` response: per-manifest `conflictKey` and shadowed list.

Clients that ignore unknown fields keep working.

## Implementation Units

1. **Contract update** — Coordinator / Track B lead. Files: `src/types.ts`,
   `docs/contracts.md`. Optional-field additions only. **Freeze contract
   before unit 2 starts.** Cross-track approval required.
2. **Compiler conflict resolution** — Track B. Files:
   `src/compiler/index.ts`, `src/compiler/manifest.ts`, plus
   `compiler/manifest` tests. Add `resolveConflicts` and wire it between
   normalization and section compilation.
3. **Store / MCP exposure** — Track C. Files: `src/mcp/tools.ts`, plus
   schemas/server/store as needed. Thread diagnostics through the three
   tool responses listed above.
4. **Integration / eval coverage** — Track C, with Track B fixtures. End-to-end
   cases that exercise duplicate loading and verify the winner is the only
   one retrieved.

## Tests

- Higher precedence wins over lower.
- Lower-precedence duplicate is **not** compiled (assert via retrieval).
- Tie at same precedence is deterministic across runs (fixed sort keys).
- Same `skillName` in different `system`s → **both** compile (no false conflict).
- Existing section-collision tests still pass (no regression).
- `index_skills` returns correct `conflictCount` and diagnostic rows.
- `list_skills` exposes per-skill `precedence` and `conflictCount`.
- `get_skill_manifest` exposes conflict fields for involved manifests.
- Retrieval after conflict contains winner content only.

## Validation Commands

```bash
npm run typecheck
npm test
npm run build
```

All three must be clean before considering the unit done.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Contract change breaks existing Track A/B/C work in flight | Coordinator freezes contract first; optional fields only |
| Tiebreak not actually deterministic (locale, platform) | Explicit `localeCompare` with stable keys; add a regression test |
| Shadowed inputs silently lost | Diagnostics mandatory whenever `shadowed.length > 0` |
| Conflict key too coarse later | Key is a single string — easy to re-key without touching algorithm |
| MCP clients choke on new fields | All additions are optional; old clients ignore unknowns |

## Agent Assignment

- **Primary: Track B** — owns the core compiler behavior (units 1 + 2).
- **Then: Track C** — owns MCP/store exposure (units 3 + 4), using Track B
  fixtures.
- **Track A: only if** a precedence-metadata propagation bug is found during
  implementation. Otherwise untouched.
- **Coordinator**: must freeze contract changes in `src/types.ts` and
  `docs/contracts.md` before Track B starts unit 2.
