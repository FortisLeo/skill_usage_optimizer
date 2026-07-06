# Parallel Implementation Tracks

Three agents work in parallel after contracts and scaffold are frozen. Each agent owns a strict allowlist of paths.

## Hard Global Execution Rule

- Agents may ONLY create or modify paths in their allowlist.
- If another path is needed: **STOP** and report: path, why, owning track.
- Inspect existing code before editing — reuse, do not duplicate.
- Report all changed paths after each work session.
- No unilateral type changes. Shared types are contract; change only via agreement.

---

## Track A — Discovery + Normalization

**Allowed paths:**
- `src/config.ts`
- `src/fs/roots.ts`
- `src/fs/freshness.ts`
- `src/discovery/**`
- `src/normalize/**`
- `tests/discovery.test.ts`
- `tests/normalize.test.ts`
- `tests/roots.test.ts`
- `tests/freshness.test.ts`
- `tests/fixtures/discovery/**`

**Phase 1:** Harness Claude/OpenCode/Codex/Copilot-compatible `SKILL.md` + `AGENTS/CLAUDE/Copilot` instructions.

**Outputs:** `NormalizedSkillInput[]` and errors.

**Must not implement:** parser, classification, retrieval, MCP tools.

---

## Track B — Compiler + Retrieval

**Allowed paths:**
- `src/parser/markdown.ts`
- `src/compiler/ids.ts`
- `src/compiler/classify.ts`
- `src/compiler/policy.ts`
- `src/compiler/manifest.ts`
- `src/compiler/index.ts`
- `src/search/lexical.ts`
- `src/retrieval/context.ts`
- `src/retrieval/references.ts`
- `tests/parser.test.ts`
- `tests/ids.test.ts`
- `tests/classify.test.ts`
- `tests/policy.test.ts`
- `tests/manifest.test.ts`
- `tests/lexical.test.ts`
- `tests/compiler.test.ts`
- `tests/retrieval.test.ts`
- `tests/fixtures/compiler/**`

**Consumes:** `NormalizedSkillInput` from fixtures.
**Outputs:** `CompileResult`, `RetrievalBundle`.

**Conflict resolution + diagnostics:** Track B owns precedence-based conflict
detection and `SkillConflictDiagnostic` generation. Conflicts are non-fatal
diagnostics on `CompileResult.diagnostics`, not `BoundaryError` entries. If
the runtime still emits conflicts as errors, Track B must migrate to the
diagnostics contract before claiming compliance.

**Must not implement:** fs discovery, store, MCP tools.

---

## Track C — Store + MCP + Evaluation

**Allowed paths:**
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/mcp/server.ts`
- `src/store/fileStore.ts`
- `src/mcp/schemas.ts`
- `src/mcp/tools.ts`
- `tests/store.test.ts`
- `tests/mcp-tools.test.ts`
- `tests/integration.test.ts`
- `tests/eval.test.ts`
- `tests/fixtures/integration/**`

**Strategy:** Use mocks until Tracks A and B land real implementations.

**Persistence + MCP exposure:** Track C owns persistence and MCP exposure of
`SkillManifest.precedence`, `SkillManifest.conflicts`, and
`CompileResult.diagnostics`. MCP tool responses must surface precedence and
conflict diagnostics to clients when present.

**Must not implement:** discovery internals, classification internals. Do not edit Track A or Track B files.

---

## Integration Order

1. Freeze contracts and scaffold.
2. Merge work behind contracts — each track compiles and tests independently.
3. Wire `index_skills` = Track A (discovery/normalize) + Track B (compile) + store.
4. Wire read/list/load MCP tools.
5. Run integration fixtures and eval suite.

## Conflict Rules

| Domain | Owner |
|---|---|
| Skill IDs | Track B |
| Conflict resolution + diagnostics | Track B |
| Persistence of precedence/conflicts | Track C |
| MCP exposure of diagnostics | Track C |
| Persistence | Track C |
| Path safety | Track A |

Cross-track type changes require agreement before merging. No track may unilaterally alter a shared contract.
