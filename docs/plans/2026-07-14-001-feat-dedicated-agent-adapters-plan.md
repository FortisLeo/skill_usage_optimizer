---
title: "feat: Add dedicated agent environment adapters"
type: feat
date: 2026-07-14
origin: docs/brainstorms/2026-07-14-dedicated-agent-environment-adapters-requirements.md
risk: HIGH
---

# feat: Add dedicated agent environment adapters

## Summary

Add narrow, capability-tiered discovery adapters for the approved agent environments while preserving the existing `DiscoveredArtifact` pipeline, explicit-root fallback, pruning, and storage behavior. OpenCode remains the first **designed** vertical slice, but roots-only adapter units may ship independently before its conditional bridge is verified.

This plan is **HIGH risk** because it changes source-system compatibility, discovery precedence and pruning, untrusted path handling, runtime handoff behavior, and persisted index results. The plan distinguishes confirmed repository behavior from external contracts that must be verified before implementation.

## Execution Preconditions and Scope

- **Stop condition before U0:** create or confirm an isolated worktree, verify `git status --short` is clean there, and preserve the current checkout and all current user changes. Do not begin U0 in the current dirty checkout.
- The first implementation change in that clean worktree adds `.skill-cache/` to `.gitignore`, before any command that can start Ruleloom or generate the cache. Existing tracked/staged `.skill-cache` data in the current checkout is user work and must not be removed or rewritten by this plan.
- This plan is documentation-only until its implementation units are executed; this revision does not modify code or tests.
- Ponytail scope is deliberate: no new dependency, public plugin SDK, universal external bridge protocol, generalized cache/transaction layer, broad crawl, or `FileStore` bridge abstraction.

## Requirements Traceability

The following requirements preserve the approved requirements document at `docs/brainstorms/2026-07-14-dedicated-agent-environment-adapters-requirements.md`.

### Coverage and capability

- **R1 / REQ-01:** Register one dedicated adapter for OpenCode, Claude Code, Codex, GitHub Copilot/VS Code, Cursor, Gemini CLI, Windsurf, Cline, Roo Code, Continue, and Aider.
- **R2 / REQ-02, REQ-10:** Runtime/config discovery is additive and conditional on a verified official/stable contract, supported versions, ownership, lifecycle, and ordering. Otherwise the adapter is roots/config-only.
- **R3 / REQ-03, REQ-04, REQ-07:** Use only verified documented roots/configuration plus explicit roots. Never guess or enumerate cache/package paths. A verified bridge may supply an exact canonical source root, including one physically located in a package cache, under the narrow policy below.
- **R4 / REQ-04, REQ-06:** Return capability, source type, bounded discovered/skipped metadata, limitations, and explicit-root guidance without contents or secrets.

### Shared contracts and safety

- **R5 / REQ-05:** Keep `discover(ctx): DiscoverResult`, existing artifact normalization/compilation, and downstream storage as the canonical path.
- **R6 / REQ-07:** Preserve `explicitRootSystem`, existing precedence, exclusions, dedupe, path safety, stale-pruning, and orphan physical section-file behavior. Orphan physical section files are ignored; do not add broad cleanup.
- **R7 / REQ-09, REQ-10:** No dependency, public adapter SDK, dynamic registry, universal bridge protocol, cache/`node_modules` enumeration, automatic host configuration, or final-prompt reconstruction.

### OpenCode

- **R8 / REQ-08:** Consume plugin-injected `config.skills.paths` only through a verified, workspace-bound companion handoff. The bridge supplies ordered paths, never content, and falls back safely when unavailable or invalid.

## Confirmed Repository Behavior vs External Contracts

### Confirmed repository behavior (observed and safe to reuse)

- `src/discovery/index.ts` dispatches adapters and isolates adapter failures in `DiscoverResult.errors`.
- `src/types.ts` owns `SourceSystem`, `DiscoveryContext`, `DiscoveredArtifact`, and `DiscoverResult`.
- `src/discovery/shared.ts` owns depth-limited scanning, classification, explicit-root scanning, path safety, and precedence. Entry/result/file-size/path-length limits are missing and are a Phase 0 prerequisite.
- `src/config.ts` owns current known roots and precedence values.
- `src/mcp/tools.ts` filters by system, persists compiled output, and prunes stale system data.
- `src/store/fileStore.ts` provides same-directory atomic writes and persisted index/manifest storage. Its savings update already uses a native exclusive lock-file protocol with bounded acquisition, PID-aware stale-lock recovery, and token-checked release; reuse that narrow pattern for indexing rather than adding a dependency or transaction framework. It is not a bridge abstraction and must not be repurposed for bridge handoffs.
- `src/discovery/candidates.ts` is a bounded, content-free candidate enumeration pattern.

### External or unconfirmed contracts (verification required before encoding)

- Official APIs/hooks, writer ownership, supported versions, lifecycle/order, invalidation, and compatibility policy for each environment.
- Documented project/workspace/user/system roots and configuration scopes per supported operating system.
- OpenCode effective `config.skills.paths` visibility without package-cache enumeration.
- OpenCode canonical handoff location, schema/version, cleanup semantics, and precedence relative to documented and explicit roots.
- Safe diagnostic path redaction and whether organization state is readable/inaccessible.

Every environment gets a contract record before its adapter ships: environment, source kind, verified owner, supported versions/OSes, canonical root/location, ordering/precedence, bounds, invalidation/cleanup, fallback, limitations, and evidence. A failed gate records roots-only behavior; it does not leave a guessed implementation behind.

## Canonical Source IDs and Public Compatibility

Existing IDs and persisted records remain unchanged: `claude`, `opencode`, `codex`, `copilot`, and `generic`. The decided future IDs are exactly `cursor`, `gemini`, `windsurf`, `cline`, `roo`, `continue`, and `aider`.

Do **not** expose those seven IDs in advance. Each new ID is added to `src/types.ts`, `src/config.ts`, `src/discovery/index.ts`, `src/discovery/candidates.ts`, `src/mcp/schemas.ts`, `src/mcp/server.ts`, and `docs/contracts.md` in the same independently shippable unit as its working adapter, fixture, tests, and user documentation. Public MCP enums and validators must agree in that unit. No migration rewrites existing IDs or persisted data; old records continue to load.

Shared scanners must require an explicit `forcedSystem`; they must not infer attribution from a shared path. Define and test deterministic dedupe/tie behavior before implementation: dedupe by canonical real path, retain the highest-precedence source, and use stable adapter/source ordering as the final tie-breaker. Preserve `explicitRootSystem` attribution and current pruning semantics.

## Key Decisions

- Keep a static dispatcher and one internal adapter per environment.
- Add ephemeral discovery diagnostics to `DiscoverResult` and expose them only as `discoveryDiagnostics` in the `index_skills` response. Existing compiler conflict `diagnostics` remains unchanged and distinct.
- Diagnostics are bounded and redact paths safely (prefer root-relative labels or stable redacted identifiers; never emit full sensitive paths, contents, prompts, tokens, or payloads).
- Runtime/config results are validated ordered paths or metadata, then enter existing scanners and the existing normalize/compile/store pipeline.
- Explicit roots remain additive and user-controlled for every environment.
- Reject inaccessible organization state, cache enumeration, overlong paths, excessive counts/sizes, unsafe realpaths, and symlink escapes.
- Runtime capture may not claim or reconstruct final prompts.

### Exact discovery diagnostic contract

`DiscoverResult.discoveryDiagnostics` is an optional array capped at 100 entries. `limitation` and `explicitRootGuidance` are each capped at 256 UTF-8 bytes; counts are non-negative integers capped at their corresponding scanner limits. Its exact entry shape is:

```ts
interface DiscoveryDiagnostic {
  environment: SourceSystem;
  capability: 'roots' | 'configuration' | 'runtime_bridge';
  sourceType: 'roots' | 'configuration' | 'runtime' | 'explicit';
  status: 'used' | 'fallback' | 'unavailable' | 'limited' | 'truncated' | 'skipped';
  code:
    | 'SOURCE_USED' | 'SOURCE_ABSENT' | 'SOURCE_UNAVAILABLE'
    | 'SOURCE_UNSUPPORTED' | 'SOURCE_INVALID' | 'SOURCE_UNSAFE'
    | 'SOURCE_INACCESSIBLE' | 'SOURCE_TRUNCATED' | 'WORKSPACE_MISMATCH';
  foundCount: number;
  skippedCount: number;
  limitation: string;             // bounded/redacted; never a raw path or payload
  explicitRootGuidance: string;   // exact `index_skills` roots fallback guidance
}
```

The response uses `discoveryDiagnostics`; it never aliases or merges with compiler conflict `diagnostics`. Request-wide fatal failures remain in `errors` and abort before persistence. Discovery diagnostics are response-only: do not write them to sections, manifests, index files, or savings data.

### Fatal versus diagnostic classification

Request-wide fatal means safe indexing cannot produce or commit a trustworthy complete target. Non-fatal classes below are skipped and fall back to the remaining documented and explicit roots.

| Class | Required handling | Named test |
|---|---|---|
| Invalid explicit-root request boundary: missing/non-directory root, unresolved source system, or unsafe/unresolvable root realpath | **Fatal `errors`; no writes.** Preserve the current explicit-root contract—including arbitrary roots attributed by `explicitRootSystem`—because silently ignoring a root the caller explicitly requested cannot safely fulfill that request. | `invalid explicit root remains fatal before persistence` |
| Pipeline/store invariant failure: pipeline-wide discovery/normalization/compile failure, unreadable live state, index-lock timeout, or section/manifest ID collision | **Fatal `errors`; no live switch.** Pre-switch writes are forbidden where specified by U0.1. | `pipeline-wide failure remains fatal before persistence` |
| Optional source absent, unsupported, inaccessible, or truncated; malformed/stale/wrong-workspace bridge handoff | **Non-fatal `discoveryDiagnostics`; skip source and fall back.** | `optional invalid source diagnoses and falls back` |
| Unsafe individual entry under an otherwise valid discovered or explicit root, including overlong/oversized/inaccessible entries and symlink escapes | **Non-fatal `discoveryDiagnostics`; skip only that entry and continue/fall back.** | `unsafe discovered entry is skipped with discovery diagnostics` |
| Expected compiler precedence conflict | **Non-fatal compiler `diagnostics`;** keep separate from discovery diagnostics. | `compiler conflict remains a non-fatal diagnostic` |

An adapter-local exception is diagnostic when other verified sources can still form a safe target; only an outer invariant failure that makes the target untrustworthy is fatal. Do not reclassify explicit-root request-boundary failures without a separately approved contract change and replacement tests.

### Shared scanner bounds

Do not call current shared scanners bounded until U0 completes. U0 applies fixed internal limits to every shared indexing scanner: at most 10,000 directory entries visited per supplied source root, 500 returned artifacts per source root, 1 MiB per candidate file, a 4,096-byte UTF-8 path limit, and the existing recursion-depth limits. Hitting a limit stops that root safely and emits `SOURCE_TRUNCATED` with found/skipped counts; oversized, overlong, inaccessible, or unsafe entries increment skipped counts without content reads. These are internal constants, not new public configuration.

## OpenCode Runtime Bridge Contract (Conditional)

Claim this bridge only after the OpenCode contract record confirms **all** of: writer ownership; writer lifecycle and event/order guarantees; supported OpenCode versions; canonical handoff location; schema/version; cleanup semantics; and precedence against documented and explicit roots. No guessed root, hook, or lifecycle becomes implementation behavior.

- The canonical supplied workspace root is the verified workspace root supplied by the caller/host contract, not `cwd`. A cwd/workspace mismatch is a non-fatal diagnostic and cannot silently retarget the scan.
- The separately shipped writer lives at `integrations/opencode/ruleloom-bridge.mjs`, declares handoff schema version `1`, is version-scoped by the package release, is included by `package.json`, and is installed from `node_modules/skill-usage-optimizer/integrations/opencode/ruleloom-bridge.mjs` using the verified host configuration documented in `docs/installation.md`. It performs same-directory atomic replacement of one canonical handoff file. Ruleloom reads that one bounded file once per discovery and never writes it.
- The writer runs only after OpenCode has finalized plugin/config merging for the workspace and before Ruleloom discovery. Its lifecycle test must prove that order and workspace identity. If order cannot be confirmed, the writer unit does not ship and OpenCode remains roots-only.
- The bridge is not `FileStore`, does not reuse indexed sections/manifests, and never enumerates a cache, package cache, dependency tree, or `node_modules`.
- The handoff is limited to 64 KiB and 100 ordered source paths. For each path, verify writer identity, workspace identity, schema version, freshness, duplicates, path length, and that the string is already its canonical real path; reject broken/cyclic/symlink aliases. Verify it is a directory before scanning.
- An exact validated canonical path may physically be inside a package cache or `node_modules`; this is the only package-cache exception. Pass `[validatedSourceRealPath]` as that scan's allowed roots and validate every encountered path/realpath against it. Containment is per validated supplied source root—not the workspace, home directory, package-cache parent, or any broad allowed-home boundary.
- Apply shared entry/result/file-size/path-length limits and per-path validation independently. One invalid path is skipped with a diagnostic; it does not authorize sibling or parent traversal.
- Missing, stale, malformed, inaccessible, wrong-workspace, unsupported, or unsafe data produces non-fatal diagnostics and uses documented roots plus explicit roots.
- A successful fallback reindex prunes prior bridge-only OpenCode entries according to current pruning semantics. Fatal discovery/normalization/compile failures preserve the prior live index because persistence has not started.
- If the host cannot expose effective paths, or final prompts cannot be reconstructed, record that limitation and remain roots/config-only.

## Implementation Units

Each environment row below is independently executable and shippable. OpenCode is the first designed slice, not a release blocker: after U0, any verified roots adapter may ship while OpenCode bridge verification continues. Runtime work is a separate unit for exactly one verified enhancement.

### Prerequisite P0 — Clean isolation and generated-cache guard

Before U0, confirm the isolated clean worktree stop condition, then add only `.skill-cache/` to `.gitignore`. Validation: `git status --short` showed clean before the edit; `git check-ignore .skill-cache/index.json` succeeds afterward. Do not touch current generated or user files.

### Phase 0 — Persistence safety, scanner hardening, and diagnostics

**U0.1 — Safe indexing commit sequence (prerequisite for adapters).** Scope only `src/mcp/tools.ts`, `src/store/fileStore.ts`, `tests/mcp-tools.test.ts`, and `tests/store.test.ts`; do not invent a transaction abstraction.

1. Discover, normalize, and compile completely before any destructive or persistent action. Any fatal error returns with the prior live index untouched.
2. After compilation and before reading indexing state, acquire one store-scoped `.index.lock`; hold it through the live-index switch and post-switch manifest cleanup, then token-check and release it in `finally`. Mirror the existing native savings lock pattern: same-process queue plus `open(..., 'wx')`, a 1-second acquisition deadline, 5 ms bounded retry, and a 30-second stale threshold. Reclaim only a well-formed lock whose PID no longer exists, after rereading and matching its token; never recover a malformed lock or steal one from a live PID. Lock timeout is fatal before any write.
3. While holding the lock, read the current live index, referenced sections, and manifests; compute the complete target index in memory. `force` changes retention rules but never calls `clearIndex()` before compilation.
4. Before **any** staged write, preflight every incoming section and manifest ID against all currently persisted live records—including records scheduled for replacement—and other incoming records. An existing section ID is reusable only when its full section content and hash match. A manifest ID is reusable only when its full content/source identity matches: `system`, canonical real `sourcePath`, full `sourceHash` (not the ID's shortened hash), and the IDs and full hashes of its referenced sections. Any mismatch is a collision and aborts with no writes or live switch.
5. Write compiled sections first using their content-derived unique logical IDs. Never overwrite a section referenced by the old index.
6. Atomically write merged manifests containing both old records and new target records. Do not remove old records yet, so the old live index remains readable through pre-switch failures.
7. Atomically replace `index.json` **last** to switch the live index.
8. While still holding the lock, best-effort prune stale manifest records with another atomic manifest write. Report cleanup failure without invalidating the new live index. Continue ignoring orphan physical section files; do not add broad file cleanup.

Promise prior-index preservation only for failures before step 7. After the live-index switch, the new index is authoritative; no rollback promise is made across the multi-file store.

Named tests: `force compile failure preserves prior live files`; `normalization failure performs no writes`; `section collision aborts before live switch`; `manifest ID collision aborts before any writes or live switch`; `merged manifests retain old records before switch`; `index is the last live write`; `post-switch stale-manifest cleanup failure leaves new index readable`; `force replaces target without early clear`; `index lock acquisition times out before writes`; `dead stale index lock is recovered without stealing a live lock`; `concurrent different-system indexing preserves both updates` (run two separate processes against one store and prove both systems remain live).

**U0.2 — Shared scanner hardening.** Scope `src/discovery/shared.ts`, `src/discovery/candidates.ts` only where it shares the same safety result, `src/types.ts`, `tests/discovery.test.ts`, and `tests/discovery-candidates.test.ts`. Add the fixed bounds above, `forcedSystem` for environment scans, per-entry realpath/symlink containment, and truncation/skipped diagnostics before any new adapter ships. Preserve `explicitRootSystem` and explicit-root behavior.

Named tests: `stops at entry limit and reports skipped`; `stops at result limit`; `skips oversized file before read`; `skips overlong path`; `rejects symlink escape at every depth`; `contains each scan to its supplied root`; `explicit root attribution remains stable`; `unsafe discovered entry is skipped with discovery diagnostics`.

**U0.3 — Response-only discovery diagnostics and stable dedupe.** Scope `src/types.ts`, `src/discovery/index.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `docs/contracts.md`, `tests/discovery.test.ts`, `tests/mcp-tools.test.ts`, and `tests/mcp-p3.test.ts`. Implement the exact `discoveryDiagnostics` shape, redaction, non-persistence, and deterministic canonical-realpath dedupe: highest precedence wins, then static adapter/source order. Preserve compiler `diagnostics` and fatal `errors` separately.

Named tests: `discovery diagnostics use exact response shape`; `diagnostics do not abort indexing`; `fatal discovery errors abort before persistence`; `invalid explicit root remains fatal before persistence`; `pipeline-wide failure remains fatal before persistence`; `optional invalid source diagnoses and falls back`; `compiler conflict remains a non-fatal diagnostic`; `compiler diagnostics remain separate`; `diagnostics are not persisted`; `diagnostic paths and limitations are redacted`; `canonical path tie uses static order`.

U0 focused gate: `npx vitest run tests/discovery.test.ts tests/discovery-candidates.test.ts tests/mcp-tools.test.ts tests/mcp-p3.test.ts tests/store.test.ts`, then the common release gate.

### Phase 1 — OpenCode designed vertical slice (independent tracks)

**U1.1 — OpenCode documented/explicit roots:** after U0, independently ship changes limited to `src/discovery/opencode.ts`, `src/config.ts`, `src/discovery/index.ts`, `src/discovery/candidates.ts`, `src/mcp/schemas.ts`, `src/mcp/server.ts`, `docs/contracts.md` (section `Agent environment contract: OpenCode`), `README.md`, `docs/troubleshooting.md`, `tests/discovery-adapters.test.ts`, and `tests/fixtures/discovery/opencode/`. Preserve the existing `opencode` ID and public compatibility. Named tests: `opencode: documented roots and explicit fallback`; `opencode: absent inaccessible excluded and bounded roots`; `opencode: deterministic precedence and redacted diagnostics`; `opencode: remains roots-only without shipped writer and reader`. Use the per-row focused gate below. Bridge verification cannot block this unit or any Phase 2 row.

**U1.2 — Versioned OpenCode writer:** only after every external gate passes, add `integrations/opencode/ruleloom-bridge.mjs`, `package.json`, `docs/installation.md`, `tests/opencode-bridge-writer.test.ts`, and `tests/fixtures/discovery/opencode/bridge/`. Ship and document the exact installation path and supported versions. Named tests: `writer runs after finalized config`; `writer binds canonical workspace identity`; `writer preserves config.skills.paths order`; `writer atomically replaces versioned handoff`; `package tarball includes documented writer path`. If lifecycle/order or installation cannot be confirmed, do not ship U1.2.

**U1.3 — OpenCode bridge reader:** depends on shipped U1.2. Scope `src/discovery/opencode.ts`, `src/types.ts` only for private context input if required, `docs/contracts.md`, `docs/troubleshooting.md`, `tests/discovery-opencode-bridge.test.ts`, and `tests/fixtures/discovery/opencode/bridge/`. Named tests: `missing bridge stays roots-only`; `cwd mismatch cannot retarget workspace`; `malformed stale and wrong-workspace bridge data diagnose and fall back`; `never enumerates cache or node_modules`; `accepts exact canonical bridge root inside package cache`; `validates every supplied root independently`; `contains scan to each supplied source root`; `rejects path count handoff size file size path length and symlink violations`; `fallback prunes prior bridge-only records after live switch`; `limitations are redacted`; `does not claim final prompt reconstruction`.

U1 focused gates: U1.1 uses its matrix gate. U1.2 runs `npx vitest run tests/opencode-bridge-writer.test.ts` plus tarball inspection. U1.3 runs `npx vitest run tests/discovery-opencode-bridge.test.ts tests/discovery.test.ts tests/mcp-tools.test.ts tests/integration.test.ts`. Each then runs the common release gate.

### Phase 2 — Independently shippable roots/config adapters

Every row is one unit. Its contract record is a named `Agent environment contract: <Environment>` section in `docs/contracts.md`; its fixture root is listed below. Each unit changes the exact common public surface `src/types.ts`, `src/config.ts`, `src/discovery/index.ts`, `src/discovery/candidates.ts`, `src/mcp/schemas.ts`, `src/mcp/server.ts`, and `docs/contracts.md`, plus only the row's adapter, fixture, tests, and user docs. For existing IDs, preserve rather than re-add the ID. For a new ID, expose it on that full surface only in its row.

The three exact table-driven base test names for every row are `<id>: documented roots and explicit fallback`, `<id>: absent inaccessible excluded and bounded roots`, and `<id>: deterministic precedence and redacted diagnostics`. Matrix extras are additional named tests.

| Unit | Environment / ID | Adapter | Contract + fixture | User docs | Named adapter tests in `tests/discovery-adapters.test.ts` |
|---|---|---|---|---|---|
| U2.1 | Claude Code / `claude` | `src/discovery/claude.ts` | `docs/contracts.md`; `tests/fixtures/discovery/claude/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.2 | Codex / `codex` | `src/discovery/codex.ts` | `docs/contracts.md`; `tests/fixtures/discovery/codex/` | `README.md`, `docs/troubleshooting.md` | three base cases; `codex: system root requires verified includeSystem` |
| U2.3 | Copilot/VS Code / `copilot` | `src/discovery/copilot.ts` | `docs/contracts.md`; `tests/fixtures/discovery/copilot/` | `README.md`, `docs/troubleshooting.md` | three base cases; `copilot: instruction scopes keep verified precedence` |
| U2.4 | Cursor / `cursor` | `src/discovery/cursor.ts` | `docs/contracts.md`; `tests/fixtures/discovery/cursor/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.5 | Gemini CLI / `gemini` | `src/discovery/gemini.ts` | `docs/contracts.md`; `tests/fixtures/discovery/gemini/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.6 | Windsurf / `windsurf` | `src/discovery/windsurf.ts` | `docs/contracts.md`; `tests/fixtures/discovery/windsurf/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.7 | Cline / `cline` | `src/discovery/cline.ts` | `docs/contracts.md`; `tests/fixtures/discovery/cline/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.8 | Roo Code / `roo` | `src/discovery/roo.ts` | `docs/contracts.md`; `tests/fixtures/discovery/roo/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.9 | Continue / `continue` | `src/discovery/continue.ts` | `docs/contracts.md`; `tests/fixtures/discovery/continue/` | `README.md`, `docs/troubleshooting.md` | three base cases |
| U2.10 | Aider / `aider` | `src/discovery/aider.ts` | `docs/contracts.md`; `tests/fixtures/discovery/aider/` | `README.md`, `docs/troubleshooting.md` | three base cases |

Each row implements verified narrow roots/configuration only, `forcedSystem`, platform-aware exclusions, and explicit-root fallback. Do not encode private extension storage, guessed hooks, cache roots, or broad home traversal. A table-driven `tests/discovery-adapters.test.ts` is preferred over repetitive files.

Per-row focused gate: `npx vitest run tests/discovery-adapters.test.ts tests/discovery.test.ts tests/discovery-candidates.test.ts tests/mcp-p3.test.ts tests/mcp-tools.test.ts tests/integration.test.ts`, then the common release gate. The row must prove its ID is accepted by both MCP schema surfaces, dispatched, candidate-attributed, documented, persisted, listed, and backward-compatible with existing records.

### Phase 3 — One verified runtime enhancement per unit

Create a separate unit only after its environment contract record passes. Examples are separate units, not a combined deliverable: `U3.1 OpenCode verified enhancement`, `U3.2 Claude verified enhancement`, `U3.3 Copilot verified enhancement`, or `U3.4 Gemini verified enhancement`. Each names one source, one supported version scope, one handoff/API, one fallback, and one validation scenario set. If verification fails, no unit is created and the adapter remains roots/config-only.

For a non-OpenCode enhancement, name the exact verified API/handoff, source and fixture paths, supported versions, lifecycle/order, fallback, and environment-prefixed tests before creating the unit. Validation is the affected adapter row gate plus `tests/mcp-tools.test.ts`, `tests/mcp-p3.test.ts`, and `tests/integration.test.ts`. Never require hidden/session-only prompt text.

### Phase 4 — Documentation and release records

Update only relevant existing docs: `docs/contracts.md`, `docs/installation.md`, `docs/tool-reference.md`, `docs/troubleshooting.md`, and `README.md`. Record only shipped behavior: capability, verified contract/version scope, roots, limitations, fallback, diagnostic fields, and explicit-root instructions. Do not create a public SDK or a final-prompt promise.

## Validation Policy

Every unit—not merely every phase—runs its focused gate and then: `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run`. Inspect the tarball list for intended files, absence of `.skill-cache/`, and, only after U1.2, presence of `integrations/opencode/ruleloom-bridge.mjs`. Include MCP-facing checks whenever an ID or response contract changes. Run `git status --short` last and confirm only that unit's planned files changed.

## Dependency Ordering

1. P0 clean isolation and `.skill-cache/` ignore rule are mandatory stop gates.
2. U0.1 safe commit sequence precedes adapter changes; U0.2 scanner hardening and U0.3 diagnostics/dedupe then complete Phase 0.
3. U1.1 and U2.1–U2.10 depend only on Phase 0 and their own verified contract records; they ship independently in risk order. No OpenCode bridge gate blocks them.
4. U1.2 requires all OpenCode writer/lifecycle/install gates; U1.3 requires shipped U1.2. Without both, OpenCode remains roots-only and bridge support is not claimed.
5. Other Phase 3 units depend only on the matching shipped adapter and verified runtime contract.
6. Phase 4 consolidates documentation for shipped/verified behavior only.

## Risks and Mitigations

- **HIGH: external contract drift:** version-scoped records, verification gates, roots-only downgrade.
- **HIGH: unsafe untrusted paths:** no cache enumeration; exact canonical bridge roots only; strict handoff/count/entry/result/file-size/path-length/realpath/symlink bounds and per-source-root containment.
- **HIGH: index corruption or data loss:** compile before writes; a store-scoped native lock serializes the state read, staged writes, live switch, and cleanup; full section/manifest collision preflight runs before writes; old manifests remain pre-switch; live index switches last. Preservation is guaranteed only before that switch; post-switch cleanup is best effort.
- **HIGH: wrong workspace:** canonical supplied workspace root and identity validation; cwd is never authoritative.
- **Sensitive diagnostics:** bounded safe redaction; no contents, secrets, prompts, or full configuration payloads.
- **Inaccessible organization state:** non-fatal diagnostic and documented/explicit fallback.
- **False completeness:** explicitly document inability to reconstruct final prompts.
- **Scope creep:** no dependency, SDK, universal protocol, generalized cache/transaction layer, broad crawl, or `FileStore` bridge abstraction.

## Acceptance Criteria

- Every baseline environment has a dedicated adapter, canonical ID, contract record, capability classification, verified scope, limitation, and explicit-root fallback.
- Existing IDs, artifact shape, normalization, compilation, explicit-root attribution, precedence, dedupe, pruning, MCP behavior, and orphan-section-file handling remain compatible.
- New IDs appear publicly only with their shipped adapter unit; existing persisted records remain readable without migration.
- Shared scanners enforce entry/result/file-size/path-length/depth limits, require `forcedSystem`, report truncation/skips, and use deterministic dedupe/tie behavior.
- Force indexing performs discovery/normalization/compilation before locking or writes; a bounded store-scoped exclusive lock covers the state read through switch and cleanup; full section/manifest collision validation precedes all staged writes; uniquely identified sections and merged manifests stage before the live index switches last. Concurrent different-system indexing preserves both updates; preservation is promised only before the live switch.
- OpenCode bridge support exists only if the separately shipped writer and reader both pass ownership/lifecycle/order/version/install/location/schema/cleanup/precedence gates. Otherwise OpenCode is documented as roots-only.
- The bridge never enumerates caches or `node_modules`; it may scan an exact verified canonical supplied root located there, contained only to that root and validated per path.
- Missing, stale, malformed, unsafe, inaccessible, wrong-workspace, or unreconstructable runtime data is non-fatal, bounded, and redacted.
- No adapter enumerates package caches, `node_modules`, arbitrary home directories, private extension storage, or hidden session state.
- `discoveryDiagnostics` has the exact response-only contract above, never persists or aborts, and remains distinct from fatal `errors` and compiler conflict `diagnostics`.
- Each unit passes its named focused tests, full suite, typecheck, build, and package tarball inspection without generated `.skill-cache` artifacts.

## Contract Record Template and Open Questions

For each environment, add a named section in `docs/contracts.md` recording: `sourceSystem`, capability tier, source type, verified owner, evidence, supported versions/OSes, canonical supplied workspace/root, ordering and precedence, bounds, realpath/symlink policy, lifecycle/invalidation/cleanup, fallback, diagnostic/redaction policy, and explicit unsupported behavior.

Open questions remain gates, not assumptions:

1. Which official APIs/hooks and versions are stable for each environment?
2. Which roots/configuration scopes are documented per OS?
3. Can the versioned OpenCode writer expose ordered effective paths after finalized config without enumerating package caches, and who owns its lifecycle?
4. What exact OpenCode lifecycle/order, location, schema, cleanup, and precedence contract is supportable?
5. What redaction policy safely handles sensitive directory names and inaccessible organization state?
6. What invalidation and compatibility behavior is required when an external format changes?
