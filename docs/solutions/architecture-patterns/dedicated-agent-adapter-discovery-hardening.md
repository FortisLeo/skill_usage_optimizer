---
title: Harden discovery with dedicated agent adapters and shared safety boundaries
date: 2026-07-18
category: architecture-patterns
module: discovery
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Supporting multiple agent environments with different documented source contracts.
  - Adding automatic discovery without crawling caches, dependency trees, or private host state.
  - Preserving explicit-root fallback and the existing indexing pipeline.
tags:
  - agent-adapters
  - discovery
  - filesystem-safety
  - explicit-roots
  - diagnostics
  - source-contracts
---

# Harden discovery with dedicated agent adapters and shared safety boundaries

## Context

Agent environments expose different instruction, skill, rule, and configuration sources. Treating them as one universal filesystem convention either misses supported sources or encourages guesses about caches, private state, and runtime prompt assembly.

The durable pattern is a narrow adapter per environment, backed by one shared scanner and the existing normalize/compile/store pipeline. Each adapter encodes only its verified contract, reports unsupported coverage, and leaves trusted nonstandard locations to explicit roots. OpenCode remains documented-roots only: no writer, reader, or runtime bridge is shipped.

## Guidance

1. **Keep adapters dedicated and dispatch static.** Register each public `SourceSystem` beside one adapter in `src/discovery/index.ts`. Avoid a public adapter SDK, dynamic registry, or universal host protocol.
2. **Make each adapter a source locator, not a second pipeline.** Return `DiscoveredArtifact[]`; keep normalization, compilation, persistence, stale pruning, and retrieval shared.
3. **Force source attribution at the scan boundary.** Pass the adapter's `SourceSystem` to `scanSourceRoot`, `scanFile`, and related helpers. A compatibility root such as `.claude/skills` must retain the requested adapter's identity rather than be inferred from its path.
4. **Centralize filesystem safety.** Reuse `src/discovery/shared.ts` for bounded entry, result, file-size, path-length, depth, realpath, symlink, and source-root containment checks. Adapter-specific enumeration must share the same budget rather than reset limits for every sub-root.
5. **Separate failures by trust boundary.** Optional missing, unsupported, inaccessible, unsafe, or truncated sources become bounded `discoveryDiagnostics`; invalid explicit-root requests and pipeline-wide failures remain fatal `errors`. Compiler conflicts remain separate `diagnostics`.
6. **Keep diagnostics response-only and redacted.** Report capability, source type, status, code, bounded counts, limitation, and explicit-root guidance—never source contents, configuration payloads, secrets, or raw sensitive paths.
7. **Gate configuration and runtime discovery on evidence.** Parse only stable, documented, bounded configuration fields needed to locate local sources. If ownership, lifecycle, version, ordering, or cleanup is unverified, emit `SOURCE_UNSUPPORTED` and stay roots-only.
8. **Preserve deterministic compatibility.** Keep explicit roots additive, canonical-realpath dedupe deterministic, precedence stable, and new source IDs synchronized across types, MCP validation, dispatch, candidate discovery, contracts, fixtures, and tests.

## Why This Matters

The environment adapter owns host-specific knowledge while the shared scanner owns untrusted-path handling. That split prevents divergent safety implementations and keeps host contract drift from leaking into storage or retrieval.

Explicit unsupported diagnostics also prevent false completeness: a successful roots scan does not imply that private configuration, runtime-selected context, or final prompts were observed. The explicit-root fallback covers trusted local sources without broadening automatic discovery.

## When to Apply

- Adding a new agent environment or a newly verified source for an existing environment.
- Supporting compatibility roots whose directory name does not identify the consuming host.
- Reading a documented config file solely to locate bounded local artifacts.
- Considering a runtime bridge, plugin hook, cache location, or private editor state.
- Changing discovery precedence, dedupe, diagnostics, or scanner bounds.

## Examples

### Static adapter registration

`src/discovery/index.ts` keeps the supported environments visible and ordered:

```ts
const DISCOVERERS = [
  ['claude', discoverClaude],
  ['opencode', discoverOpencode],
  ['codex', discoverCodex],
  // ...one entry per supported environment
] as const;
```

The dispatcher can then honor `requestedSystem`, isolate optional adapter failures, combine explicit-root results, and apply canonical-path dedupe once.

### Forced attribution through the shared scanner

An OpenCode-compatible Claude skill root is still indexed as OpenCode:

```ts
for (const dir of DEFAULT_SKILL_DIRS.opencode) {
  results.push(...scanSourceRoot(
    join(baseDir, dir),
    allowedRoots,
    ctx,
    'opencode',
    3,
    onScan,
    scannerLimits,
    budget
  ));
}
```

This preserves `index_skills(system: "opencode")` semantics without path-name heuristics.

### Honest roots-only fallback

`src/discovery/opencode.ts` records the unshipped runtime capability instead of reading package caches or pretending effective plugin paths are known:

```ts
onDiagnostic?.({
  environment: 'opencode',
  capability: 'runtime_bridge',
  sourceType: 'runtime',
  status: 'unavailable',
  code: 'SOURCE_UNSUPPORTED',
  foundCount: 0,
  skippedCount: 0,
  limitation: 'Runtime-effective plugin paths are unavailable; only documented roots are scanned.',
  explicitRootGuidance: EXPLICIT_ROOT_GUIDANCE
});
```

## Prevention Checklist

- [ ] Record official evidence, supported scope, precedence, bounds, fallback, and limitations in `docs/contracts.md` before shipping a source.
- [ ] Add or update the `SourceSystem` everywhere its public contract is validated and dispatched; do not expose an ID before its adapter works.
- [ ] Use shared scan helpers with an explicit system and one adapter-wide budget.
- [ ] Contain every artifact to its individual supplied source root and the allowed discovery roots.
- [ ] Reject symlinks, escapes, oversized or overlong files, inaccessible entries, caches, and dependency trees.
- [ ] Keep optional-source diagnostics non-fatal, bounded, redacted, and response-only.
- [ ] Keep explicit-root boundary failures fatal and explicit-root attribution stable.
- [ ] Test documented roots, absent/unsupported sources, exclusions and bounds, precedence, redaction, explicit fallback, and end-to-end store compatibility.
- [ ] Re-verify external contracts before adding runtime/config behavior or after upstream contract changes.
- [ ] For OpenCode, keep roots-only behavior unless separately verified writer and reader units are both shipped.

## Related

- [Dedicated agent adapter implementation plan](../../plans/2026-07-14-001-feat-dedicated-agent-adapters-plan.md)
- [Dedicated agent environment adapter requirements](../../brainstorms/2026-07-14-dedicated-agent-environment-adapters-requirements.md)
- [Agent environment contracts](../../contracts.md#agent-environment-contract-claude-code)
- [Discovery adapter implementation](../../../src/discovery/index.ts)
- [Shared scanner safety boundary](../../../src/discovery/shared.ts)
- [Adapter contract tests](../../../tests/discovery-adapters.test.ts)
- [Platform-aware home scan exclusions](platform-aware-home-scan-exclusions.md)
