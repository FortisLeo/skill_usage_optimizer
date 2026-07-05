---
title: Keep track contracts and implementation boundaries aligned
date: 2026-07-04
last_updated: 2026-07-04
category: workflow-issues
problem_type: workflow_issue
track: knowledge
module: production hardening
tags:
  - contracts
  - parallel implementation
  - track boundaries
  - production readiness
applies_when:
  - Parallel agents implement separate tracks against shared contracts.
  - A track changes result shapes or accidentally creates files owned by another track.
  - Helper-level tests pass but package, MCP, or persistent-store paths have not exercised the same contract.
---

# Keep track contracts and implementation boundaries aligned

## Context

Track A was limited to discovery and normalization, but parallel agents drifted into Track B/C files and contract shapes. The safe final state kept only Track A code and updated `docs/contracts.md` to match the implementation.

Later production hardening showed the same lesson at a larger boundary: unit helpers passed, but package/MCP/store paths still had to prove they preserved the real contracts end to end.

## Guidance

- Treat `docs/contracts.md` as the source of truth for shared result shapes and module entry points.
- For Track A, keep the boundary contracts explicit:

  ```typescript
  type DiscoverResult = { artifacts: DiscoveredArtifact[]; errors: BoundaryError[] };
  type NormalizeResult = { inputs: NormalizedSkillInput[]; errors: BoundaryError[] };

  discover(ctx) -> DiscoverResult;
  normalize(artifacts, ctx) -> NormalizeResult;
  ```

- Enforce `docs/parallel-implementation-tracks.md` literally: if a file is outside the active track allowlist, delete or revert it instead of trying to integrate it opportunistically.
- After cleanup, run the track-local validation that proves the boundary still holds.
- Before calling work production-ready, exercise the published surfaces, not just the helper functions:
  - package entry point and `bin` wiring
  - MCP server/tool calls
  - manifest-backed store/list/get behavior
  - persisted freshness data (`mtime`, `size`, `hash`) across discovery, normalization, and reload
  - generated preamble/context loading
- Contract drift includes metadata and attribution fields: when `NormalizedSkillInput` gained `size` and explicit roots needed system attribution, `docs/contracts.md` had to name both, normalization had to use fresh stat data for `mtimeMs` and `size`, and `DiscoveryContext.explicitRootSystem` stayed scoped only to explicitly requested roots.

## Why This Matters

Parallel work only stays safe when each track can trust the frozen contracts. Letting Track B/C files leak into a Track A change makes validation ambiguous and turns a small implementation into an accidental integration pass.

Production readiness needs the same discipline. A parser, normalizer, or freshness helper can be correct in isolation while the packaged tool drops metadata, defaults to the wrong explicit root, truncates normalized markdown, or exposes broken MCP/store behavior.

## When to Apply

Use this whenever agents are working from the track plan, especially after merge/conflict cleanup or when a result object shape changes. Also use it before release hardening: every contract that matters should be exercised through the surface users actually run.

## Example

For the Track A pass, the final validation was intentionally narrow:

- `npm test`: 4 Track A test files, 56 tests passed
- `npm run typecheck`: clean

That was enough because non-Track-A files had been removed and the approved contracts matched the implemented APIs.

For the production-hardening pass, the final validation widened to the actual delivery surfaces:

- `npm test`: 214/214 passed
- `npm run typecheck`: clean
- `npm run build`: clean
- `npm pack`: package produced successfully

That caught the durable requirement: freshness must carry and persist `mtime`/`size`/`hash`; normalization must preserve full normalized markdown while parsing frontmatter separately; frontmatter, explicit roots, top-level result-object catches, MCP tooling, manifest-backed system filters, and generated preamble context all need end-to-end coverage.
