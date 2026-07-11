# Skillsect-on-Ruleloom: Remaining Build Roadmap & Test Plan

**Status as of this doc:** Phase P0 (schema) and Phase P1 (BM25F search)
complete and verified. Phase P2 (dependency resolver) complete and
verified, stopped cleanly before P3 as instructed.

**Purpose of this doc:** one reference for everything still ahead —
what each remaining phase actually builds, how to test it *before*
declaring it done, and the specific failure patterns already caught
twice in this build (misleading aggregate metrics, silent behavior
changes, unmeasured claims) so they don't repeat in later phases.

---

## 0. The one rule that applies to every phase below

**A number is not a result until it's broken down and cross-checked.**
Twice already in this build, an aggregate metric looked like a pass and
wasn't: Phase P1's first precision@3 report (83.3% combined) hid a real
miss on real-world queries (78.6%, below target) behind easy synthetic
heading-matches (90%). Every gate below is written to force the
split/breakdown up front, not as an afterthought after a misleading
headline number gets reported.

---

## 1. Where things stand

| Phase | What it builds | Status |
|---|---|---|
| P0 | Merged schema, new types | ✅ Done |
| P1 | BM25F search, code identifier extraction | ✅ Done (real-only precision@3 = 92.9%) |
| P2 | Dependency resolver (requires/related, cycles, trust) | ✅ Done (recall = 1.0, cycle + trust checks pass) |
| P3 | MCP tool surface (search/resolve/doctor tools) | ⬜ Next |
| P4 | Floor-invariant fix to `rebuildRequired` | ⬜ |
| P5 | CLI | ⬜ |
| P6 | `doctor` command | ⬜ |
| P7 | Flows (author-declared recipes) | ⬜ Conditional |
| P8 | Learned edges (usage telemetry) | ⬜ Conditional — only if P2 miss-rate warrants it |
| P9 | Native hooks (Claude Code / OpenCode plugin) | ⬜ Conditional — only if MCP round-trip proven bottleneck |
| — | **Token-savings measurement** (currently unmeasured) | ⬜ Should happen alongside P3, see §8 |

---

## 2. Phase P3 — MCP tool surface

**What it builds:** exposes the resolver (P2) and search (P1) as MCP
tools on Ruleloom's existing server, plus reconciles tool names between
what Ruleloom already ships and what this build adds.

**New/changed tools:**
- `search_skill_sections(query, phase?, skill?, k?)` — new
- `resolve_task_sections(query, phase?, skill?, budget?)` — new, the
  main deliverable of the whole merge
- `doctor()` — new (stub in P3, full logic in P6)
- `load_skill_context(...)` — extended with `phase` filter (partially
  exists already)
- `load_section(...)` — extended to include dependency metadata in the
  response
- `index_skills`, `list_skills`, `get_skill_manifest`,
  `get_skill_sections` — unchanged, adopt as-is

### How to test P3

1. **Parity test, not a new correctness test.** P1 and P2 already have
   passing evals for search and resolve logic. P3 doesn't need to
   re-prove that logic is correct — it needs to prove the MCP tool
   wrapper doesn't change the answer. Gate: run the same 24-query eval
   set through the MCP tool call path and through the direct
   library-function call path; results must be byte-identical (or
   semantically identical if serialization differs, e.g. field
   ordering). Any divergence means the MCP layer introduced a bug, not
   a resolver bug.
2. **Schema validation on the wire.** MCP tool inputs/outputs are
   JSON-schema-typed. Test that malformed input (missing `query`, bad
   `budget` type, unknown `skill` name) produces a clean MCP error
   response, not an unhandled exception that crashes the server.
3. **Tool registration test.** Confirm all tools (old + new) appear in
   the server's tool list and that names don't collide with anything
   Ruleloom already exposes.
4. **Backward compatibility check.** Anything that was calling the
   *existing* Ruleloom tools (`load_skill_context`, etc.) before this
   merge must still get the same response shape for calls that don't
   use the new optional fields (e.g. omitting `phase` still works as
   before).

**Do not treat "the new tools exist and return something" as done.**
The gate is the parity check against P1/P2's already-verified logic.

---

## 3. Phase P4 — Floor-invariant fix (`rebuildRequired` behavior change)

**What it builds:** the one deliberate behavior change to existing,
tested Ruleloom code. Currently, a stale content-hash causes Ruleloom to
hard-refuse the read (`REBUILD_REQUIRED`). Per the resolved design, this
must instead degrade to a whole-file read with a warning — never worse
than pre-merge behavior, per the floor invariant.

**This is the highest-risk phase for silent regressions**, because
it's the only phase that *modifies* rather than *extends* working code.

### How to test P4

1. **Before touching code:** write down every existing test that
   currently exercises `REBUILD_REQUIRED` / staleness behavior. Read
   what they assert. You are about to change what they should assert —
   confirm which ones need deliberate updates (expected: hard-refuse →
   degrade-with-warning) vs. which ones test unrelated staleness
   plumbing and shouldn't need to change at all.
2. **New test: stale read still returns usable content.** Force a
   stale-hash condition (edit a source file without re-indexing, then
   call `load_section`/`load_skill_context`), confirm the response
   contains actual content plus a warning field — not an error, not an
   empty body.
3. **New test: warning is distinguishable from a normal response.**
   Whatever consumes this (agent, CLI, MCP client) must be able to tell
   "this worked but may be stale" apart from "this is fresh." Test that
   the field exists and is machine-checkable, not just a string buried
   in prose.
4. **Regression gate: run the full existing suite, not just the
   staleness-related tests.** This phase touches shared plumbing
   (`src/mcp/tools.ts`, `src/fs/freshness.ts`) — confirm nothing
   unrelated broke. Report full before/after counts, same as every
   other phase, per §0's rule.
5. **Explicit confirmation of the floor invariant claim.** Don't just
   assert "this satisfies the floor invariant" — restate in the report
   what today's actual behavior was (hard refuse) and what it becomes
   (degrade + warn), and confirm degrade+warn is strictly not worse for
   every call site that currently handles `REBUILD_REQUIRED` as an
   error — check whether any existing caller specifically depended on
   the hard-refusal behavior (e.g. to trigger an automatic re-index) and
   would break if it silently got stale content instead.

---

## 4. Phase P5 — CLI

**What it builds:** `src/cli.ts`, a thin wrapper exposing `index`,
`search`, `resolve`, `get`, `doctor`, `watch`, `stats` as shell commands
— no new logic, pure plumbing over P1–P4's library functions.

### How to test P5

1. **Output-identity test.** For every CLI command, confirm its output
   matches the equivalent MCP tool call's output (modulo JSON vs.
   pretty-print formatting). This is the same "thin wrapper, no new
   logic" parity principle as P3 — the CLI must not develop its own
   opinions about what an answer looks like.
2. **Exit code correctness.** `doctor` finding a warning-level issue vs.
   an error-level issue (per P2's trust-tier severity split — lower→higher
   trust violations are CI-blocking errors, higher→lower are warnings)
   should map to different exit codes, since CI pipelines will gate on
   this. Test both cases explicitly.
3. **`--json` flag consistency.** If both human-readable and JSON output
   modes exist, test that JSON mode output is stable/parseable (a
   snapshot test), since anything scripting against the CLI will depend
   on that shape not silently drifting.
4. **`watch` mode:** test that editing a skill file triggers
   re-indexing without a manual `index` call, and that a second edit
   shortly after doesn't cause a race/duplicate-index condition.

---

## 5. Phase P6 — `doctor` command (full implementation)

**What it builds:** the actual validation logic — cycles, dangling
deps, cross-trust violations, oversized sections — that P2 already
detects internally but currently keeps as internal diagnostics only.
P6 surfaces these properly through the CLI and MCP `doctor` tool
stubbed in P3.

### How to test P6

1. **One test fixture per diagnostic category**, each deliberately
   broken in exactly one way:
   - a cycle (P2 already has `cycle-skill.md` — reuse it)
   - a dangling `requires` target (points at a section ID that doesn't
     exist)
   - a lower→higher trust hard dependency (should report as
     CI-blocking `error`)
   - a higher→lower trust hard dependency (should report as `warn`)
   - an oversized section (exceeds `max_section_tokens`)
   - (new, if not covered by P4) a shadowed safety preamble, per §10
     open question 3's `--diff-preambles` note — confirm this is
     actually implemented if it was promised, not left as a TODO that
     silently never gets built.
2. **Severity-to-exit-code mapping**, tested from P5's CLI, not just
   the internal function — confirm the exit code contract actually
   holds end-to-end, not just at the library level.
3. **Clean-corpus test.** Run `doctor` against a corpus with none of
   the above issues, confirm zero false positives — this matters as
   much as catching real issues, since a noisy `doctor` that flags
   healthy skills will get ignored.
4. **No auto-fix behavior sneaks in.** `doctor` is diagnostic-only per
   every prior decision in this build (report, never silently repair or
   block resolution at runtime). Test that running `doctor` doesn't
   mutate any skill file or index — a pure read/report operation.

---

## 6. Phase P7 — Flows (conditional, build if there's real signal)

**What it builds:** author-declared `<!-- flow: ... -->` annotations,
parsed and indexed, with resolve() short-circuiting to the flow's
ordered member list when a query matches a flow instead of walking the
dependency graph.

**Before building:** confirm there's actual signal this is needed —
i.e., real multi-step workflows in your corpus where graph-walking
alone produces a worse-ordered or incomplete result than an explicit
recipe would. If P2's dependency-graph approach already handles the
known multi-step cases correctly (it does, per the P2 eval — both
`isMultiSection` cases passed with correct ordering via graph-walking
alone), P7 may not be urgent. Don't build it just because it's next in
the phase list.

### How to test P7

1. **Flow parsing test.** A skill file with a `<!-- flow: ... -->`
   comment produces a correctly-parsed `FlowNode` with ordered `steps`.
2. **Flow short-circuit test.** A query matching a flow's name/summary
   returns exactly the flow's declared members in the flow's declared
   order — and does *not* fall through to graph-walking (confirm this
   by checking `matchedFlow` is populated in `ResolveResult`, per the
   P0 schema).
3. **Flow vs. graph-walk consistency check.** For a skill that has both
   a flow *and* enough `requires` edges that graph-walking alone would
   reach a similar answer, confirm the flow's explicit order is used
   over the graph-walk order, and that they don't silently disagree
   without it being visible (log or diagnostic if a flow's declared
   order contradicts the graph's inferred prerequisite order — that's
   likely an authoring mistake worth catching, not silently ignoring).
4. **Searchability test.** Per §10 open question 6's resolution
   (flow's `summary` treated as `heading_path` weight in BM25F),
   confirm a flow actually surfaces in top-3 search results for a
   query matching its declared summary.

---

## 7. Phase P8 & P9 — do not build speculatively

Both are explicitly conditional in the merged spec:

- **P8 (learned edges)** — only build if P2's dependency recall,
  measured on real production usage (not just the eval set), is below
  1.0 after P2 ships. If P2's graph-walking + inference is already
  hitting full recall on real traffic, this phase has no problem to
  solve yet.
- **P9 (native hooks)** — only build if real usage data shows the MCP
  round-trip (search → resolve → load, as separate tool calls) is an
  actual measured bottleneck (latency or model-invocation-reliability
  data), not a theoretical one.

**Test for "should we build this at all," before testing the phase
itself:** instrument P3's MCP tools to log (a) how often resolve()
returns full recall vs. a gap, and (b) round-trip latency, once this is
in real use. Report those numbers before deciding to start P8 or P9 —
building them without that data is exactly the kind of premature
complexity earlier phases of this build were designed to avoid (see the
original design's "add complexity only when data demands it" principle).

---

## 8. The missing metric: actual token savings (do this alongside P3)

This has not been measured anywhere in the build so far, and it's the
actual point of the whole system — retrieval accuracy (P1's precision@3)
and dependency correctness (P2's recall) are necessary but don't by
themselves prove the system saves context.

**What to measure:**

For every query in the eval set (and ideally on real usage once P3 is
live):
```
tokens_loaded = sum(tokenCount for each ResolvedSection in the response)
tokens_whole_file = tokenCount of the full source skill file
savings_pct = 1 - (tokens_loaded / tokens_whole_file)
```

**Report as a distribution, not one average** — per §0's rule, an
average alone can hide the real story. Specifically report:
- Savings on single-section queries (should be substantial — most of
  the win)
- Savings on multi-section (`isMultiSection: true`) queries (should be
  smaller, since more of the file is legitimately needed — check this
  isn't accidentally negative, i.e. resolver overhead shouldn't make a
  multi-section pull cost *more* than just loading the whole file would
  have)
- Cases where `collapsed: true` fired (savings should be ~0% by design
  — confirm the collapse valve isn't firing so often that it's quietly
  erasing most of the system's benefit; if most queries end up
  collapsing to whole-file, that's a signal the corpus doesn't actually
  have the multi-section-bloat problem this system was built for)

**Where this plugs in:** add this as a `stats` output in P5's CLI
(`skillsect stats` already exists in the phase list — extend it to
include this), and/or a field on `resolve_task_sections`'s MCP response
so callers can see it per-call, not just in aggregate.

---

## 9. Cumulative regression discipline across all remaining phases

Every phase above inherits this from P0–P2's actual practice in this
build, and it should not be dropped as later phases feel more routine:

1. Full test suite run **before and after**, actual output shown, not
   summarized as "passes."
2. Any metric reported as a headline number must also be reported
   broken down by the subset that's actually hard (real vs. synthetic
   queries, single- vs. multi-section, etc.) — per §0.
3. Any place the implementation diverges from what the spec says, or
   the spec turns out to be ambiguous/wrong against the real codebase,
   is a stop-and-report event, not a silently-resolved one — this
   caught the `references` optional-vs-required mismatch in P0 and
   should keep catching things in P3–P9.
4. A phase is not "done" because code was written and it compiles — it
   is done when its specific gate (stated in each phase above) is met
   and shown, not asserted.
