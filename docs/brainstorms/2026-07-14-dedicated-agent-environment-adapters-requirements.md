# Dedicated Agent Environment Adapters — Requirements

**Date:** 2026-07-14

**Status:** Approved requirements

## Problem and outcome

Ruleloom needs reliable skill/rule discovery across the agent environments users
already run. A single universal adapter cannot safely model each environment's
runtime and configuration behavior. Dedicated adapters should discover the
effective sources when supported, explain limitations when not, and preserve an
explicit-root fallback.

The outcome is predictable, diagnosable indexing without pretending to control
or fully reconstruct any host environment.

## Users

- Developers using Ruleloom with one or more supported agent environments.
- Teams validating which skills/rules are actually discoverable.
- Maintainers diagnosing missing or environment-specific sources.

## Requirements

| ID | Requirement |
|---|---|
| REQ-01 | Provide dedicated adapters for OpenCode, Claude Code, Codex, GitHub Copilot/VS Code, Cursor, Gemini CLI, Windsurf, Cline, Roo Code, Continue, and Aider. |
| REQ-02 | Capture effective runtime sources when an official, stable API or hook exists. |
| REQ-03 | When no such API or hook exists, automatically discover documented filesystem roots and configuration. |
| REQ-04 | Make runtime/config fallback behavior and limitations explicit per environment. |
| REQ-05 | Reuse Ruleloom's shared artifact, indexing, compiler, and store pipeline. This feature is not a public universal adapter protocol. |
| REQ-06 | Define support as automatic discovery, explicit limitations/diagnostics, fixtures, and tests—not automatic installation or configuration. |
| REQ-07 | Preserve manual explicit-root indexing as a fallback for every environment. |
| REQ-08 | Treat OpenCode plugin-injected `config.skills.paths` under package caches as the immediate problem to solve. |
| REQ-09 | Permit a companion plugin/runtime bridge for OpenCode to capture effective skill paths, with documented-roots discovery as fallback. |
| REQ-10 | Do not broadly crawl caches or `node_modules`, claim complete final-prompt reconstruction, or invent unstable hooks. |

## Environment capability matrix

These classifications are capability targets; exact sources and limitations
remain subject to the verification questions below.

| Environment | Target capability | Caveats |
|---|---|---|
| OpenCode | Hybrid: runtime bridge plus documented roots | Plugin-injected `config.skills.paths` may exist only in package caches; bridge availability must be explicit. |
| Claude Code | Hybrid where an official stable runtime/context hook is available; otherwise roots | Effective runtime behavior and documented configuration boundaries require verification. |
| Codex | Hybrid where an official stable runtime/context hook is available; otherwise roots | Do not infer undocumented prompt or cache state. |
| GitHub Copilot / VS Code | Hybrid: supported extension/workspace roots plus stable host APIs where available | Extension, workspace, and user scopes may differ; no broad editor-state crawl. |
| Cursor | Hybrid where stable documented integration exists; otherwise roots | Project, user, and extension-managed sources may have different precedence. |
| Gemini CLI | Hybrid where stable documented runtime/config access exists; otherwise roots | Preserve limitations around generated or session-only context. |
| Windsurf | Roots-only unless a stable official hook is verified | Do not depend on private extension or cache internals. |
| Cline | Roots-only unless a stable official hook is verified | Workspace and extension-managed state may not be equivalent to effective runtime input. |
| Roo Code | Roots-only unless a stable official hook is verified | Avoid private extension storage and cache crawling. |
| Continue | Hybrid: documented configuration/workspace roots, plus stable runtime access if verified | Configuration formats and scopes may vary by version. |
| Aider | Hybrid: documented config/repository roots, plus stable runtime access if verified | Session-specific prompt composition is not guaranteed to be reconstructable. |

For every adapter, diagnostics must state what was found, what was skipped, the
source type used (runtime, configuration, or roots), and how to provide an
explicit root when automatic discovery is insufficient.

## Scope

- Discovery and diagnostics for all named environments.
- Environment-specific fixtures and tests for supported discovery paths.
- Documentation of fallback behavior, limitations, and compatibility.
- OpenCode runtime-bridge evaluation and documented-roots fallback.
- Continued support for manual explicit-root indexing.

## Non-goals

- Automatic installation, enablement, or configuration of host environments.
- A public universal adapter protocol.
- Broad crawling of caches, package caches, or `node_modules`.
- Complete reconstruction of final prompts or hidden/session-only context.
- Reliance on undocumented, private, or unstable hooks.
- Replacing the shared internal processing pipeline.

## Success criteria

- Each named environment has a dedicated adapter with a documented capability
  classification and limitation report.
- A supported environment discovers its documented sources without manual path
  entry when those sources are present.
- OpenCode can account for plugin-injected skill paths through the bridge when
  available, and otherwise reports the documented-roots fallback clearly.
- Explicit-root indexing remains usable and equivalent as a user-controlled
  fallback.
- Fixtures and tests cover positive discovery, absent/unsupported runtime
  access, diagnostics, exclusions, and explicit-root fallback.
- No adapter requires broad cache or `node_modules` crawling.

## Safety and privacy constraints

- Read only documented, user-selected, or narrowly scoped environment sources.
- Never silently expand discovery into caches or dependency trees.
- Report paths and omissions without exposing secret contents in diagnostics.
- Do not claim runtime completeness where session state or hidden prompt inputs
  are unavailable.
- Treat explicit roots as user intent and preserve existing exclusion behavior.

## Compatibility

- Existing shared artifact/indexing/compiler/store behavior remains unchanged.
- Existing manual explicit-root workflows remain supported.
- Adapters must degrade gracefully when an environment is absent, changed, or
  lacks a stable runtime hook.
- Version-specific behavior must be represented as a limitation or capability
  check, not as an assumed universal contract.

## Assumptions

- Official documentation is the authority for stable APIs, hooks, and roots.
- Runtime capture is optional and must not be required for basic indexing.
- Environment support can be delivered independently by capability and risk.
- The named environment list is the approved scope for this effort.

## Phased acceptance criteria

### Phase 1 — Contract and safe fallback

- Define the adapter support/diagnostic expectations.
- Preserve and test explicit-root indexing.
- Implement documented-root discovery for the lowest-risk environments.
- Verify exclusions and secret-safe diagnostics.

### Phase 2 — Runtime and hybrid capabilities

- Add only verified stable runtime/API integrations.
- Add hybrid fallback from runtime/config discovery to documented roots.
- Add fixtures and tests for each delivered environment and failure mode.
- Document version and scope limitations.

### Phase 3 — OpenCode and remaining environments

- Validate the OpenCode plugin/runtime bridge for effective
  `config.skills.paths`.
- Ensure documented-roots fallback works when the bridge is unavailable.
- Deliver the remaining named adapters in capability/risk order.
- Confirm every adapter meets the definition of supported in REQ-06.

## Outstanding verification questions

1. Which official stable runtime APIs or hooks are currently available for each
   named environment, and what versions do they cover?
2. What documented filesystem roots and configuration scopes apply per
   environment and operating system?
3. Can the OpenCode companion bridge observe plugin-injected
   `config.skills.paths` without reading broad package caches?
4. What diagnostics are safe to expose when discovered paths contain sensitive
   directory names or configuration metadata?
5. Which environment changes should invalidate or refresh discovered sources?
6. What compatibility policy applies when a documented source changes format or
   is removed?
