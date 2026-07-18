# Skillsect-on-Ruleloom — Project Status

**What this is:** an extension to the Ruleloom MCP server that adds
section-level (sub-file) search and dependency-aware retrieval on top
of its existing whole-file skill indexing — so an agent loading a
matched skill gets only the relevant sub-sections plus anything they
genuinely depend on, instead of the entire file every time.

**Status:** Core build (P0–P6) complete and verified against real
production code paths. Real-world validation has not started. See §4.

---

## 1. The problem this solves

Agent skill files (`SKILL.md` and similar) are often bundled — one file
covering several loosely related sub-topics (e.g. a `chrome-automation`
skill covering setup, navigation, form-filling, screenshots, cookies,
submit). Existing skill-loading systems (including Ruleloom, which this
project extends) resolve **which file** to load, then load it **whole**.
If a task only needs one section, the rest is wasted context.

The added risk of naive section-splitting: some sections silently
depend on others (`submit` presupposes `detect-fields` already ran). A
system that blindly serves an isolated section can hand an agent
broken or incomplete instructions with no warning.

This project solves both: retrieve at section granularity, but
guarantee dependency-correct bundles when a section isn't self-contained.

## 2. What it actually does, end to end

1. **Indexing** (built on Ruleloom, unmodified) — parses skill files
   from multiple formats/sources into one internal representation, with
   content-hash based staleness detection and precedence resolution
   across sources (workspace > global > explicit root > system).

2. **Search** — BM25F full-text search over section-level metadata
   (heading path, summary, keywords, extracted code identifiers), with
   a `phase` filter (planning/implementation/review/debugging) as an
   additional narrowing axis on the new tools.

3. **Dependency resolution** — given a matched section, walks its
   `requires` (hard, always included, ordered) and `related` (soft,
   budget-permitting) edges, transitively, with:
   - Cycle detection (never loops/crashes; cycle members treated as
     co-required)
   - Cross-trust enforcement (a lower-trust skill's hard dependency on
     higher-trust content is blocked/demoted; the reverse is allowed
     but the pulled content is envelope-wrapped as untrusted reference)
   - A token budget with a collapse-to-whole-file valve (if the
     mandatory closure already approaches the whole file, stop being
     clever and just load the file)

4. **Interfaces** — the same resolve/search logic is exposed three
   ways, kept in parity with each other:
   - **MCP tools** (`search_skill_sections`, `resolve_task_sections`,
     `doctor`, plus extended existing Ruleloom tools)
   - **CLI** (`skillsect search / resolve / get / doctor / watch / stats`)
   - (Native runtime hooks were scoped as a future option, not built —
     see §5)

5. **Diagnostics** (`doctor`) — read-only checks for cycles, dangling
   dependencies, cross-trust violations, oversized sections, and
   shadowed safety preambles, with a CI-friendly exit code contract
   (0 = clean, 1 = warnings, 2 = errors).

6. **Safety invariant carried through every phase** — retrieval fallback
   paths (weak search match, ambiguous precedence, a
   dependency resolution failure) degrades to at least today's
   whole-file-load behavior. The system can only help; it's designed to
   never regress below what existed before it. Stale indexes are the
   security exception: they return bounded rebuild metadata only.

## 3. What's been built and verified (complete)

| Phase | Delivered | Verified via |
|---|---|---|
| P0 | Merged schema (requires/related/provides/uses/flowOf etc.), additive to Ruleloom's types | Full existing suite unchanged |
| P1 | BM25F search, code-identifier extraction, empty-parent-section aggregation fix, H1-overweighting fix | Real-only precision@3 = 92.9% (target: ≥80%) |
| P2 | Dependency resolver — hard/soft edges, cycle detection, cross-trust enforcement, budget + collapse valve | Dependency recall = 1.0 on multi-section eval cases; cycle detection confirmed on synthetic fixture |
| P3 | MCP tool surface (`search_skill_sections`, `resolve_task_sections`, `doctor` stub), token-savings measurement added to resolve response | CLI/MCP parity across full 24-query eval set; token savings: single-section mean 46.92% (range 25–88.64%), multi-section 65.8–68.3% (non-negative, confirming resolver overhead doesn't erase the benefit) |
| P4 | Stale index reads return bounded `REBUILD_REQUIRED` metadata without rereading changed source content | Regression coverage for stale retrieval tools |
| P5 | CLI (`index/search/resolve/get/doctor/watch/stats`) | Output-identity parity vs. MCP tools on all commands; watch-mode race-condition tested with rapid double-edits |
| P6 | Full `doctor` implementation, CI exit-code contract | All diagnostic categories fixture-tested individually; read-only confirmed (no mutation of source/index); CLI/MCP parity confirmed |
| Post-core | Eval-drift remediation: found and fixed the eval scripts silently diverging from production logic since P1 (this had inflated earlier precision/recall numbers); re-verified against real production code paths | Real-only precision@3 re-confirmed at 92.9% post-fix, matching originally reported (pre-drift) number |
| Post-core | Usage instrumentation — local, privacy-scoped logging of follow-up rate and latency, explicitly labeled as an approximation | Privacy scoping verified (no query text/content/section IDs persisted); fresh-state and populated-state output both verified |

**A note on the eval-drift finding, because it matters for how much to
trust the numbers above:** partway through this build, the eval scripts
used to compute P1/P2's metrics were found to have silently diverged
from the real production code (different section-building logic, fake
IDs/hashes, missing metadata). Re-measuring against actual production
code revealed a real regression (real-only precision@3 had dropped to
71.4%) caused by generic top-level (H1) sections outscoring specific
ones in BM25F. This was root-caused and fixed (a targeted score
dampener for top-level sections), and re-verified — real-only precision
landed back at 92.9%, matching what was originally (and, it turned out,
inaccurately) reported. The numbers in the table above are the
post-fix, production-path-verified numbers, not the original ones.

## 4. What's still pending — not yet tested or validated

This is the honest gap. Everything below is either explicitly
unmeasured, or gated on data that doesn't exist yet.

### 4a. Real-world usage — nothing has run against actual tasks yet

Every metric so far (precision@3, recall, token savings) comes from a
24-query hand-built eval set (synthetic heading-matches + paraphrased
task scenarios) against 3 test skills. None of it comes from a real
agent doing real work against a real skill corpus.

**Pending:** run this MCP server / CLI against a live Claude Code or
OpenCode session doing normal tasks, for long enough to accumulate
meaningful `stats` data, then check:
- Does token-savings hold up outside the eval set's 3 skills?
- Does the collapse-to-whole-file valve fire more or less often than
  expected on a real, larger skill corpus?
- Does real search precision hold up against real, messier queries
  (not hand-paraphrased ones)?

### 4b. The usage-signal instrumentation has zero real data

`usageSignals` (follow-up rate, latency percentiles) exists and is
tested for correctness of the mechanism, but every number currently
reported from it is 0 — it's never seen real traffic. This is the data
that's supposed to answer whether P7/P8/P9 (below) are actually needed.

### 4c. Phases P7, P8, P9 — not built, correctly deferred, but genuinely
   unvalidated either way

- **P7 (Flows — named multi-step recipes):** not built. P2's
  graph-walking already correctly ordered both multi-section eval
  cases without needing an explicit flow. Whether this holds on more
  complex real workflows is untested.
- **P8 (Learned edges from usage telemetry):** not built. Requires real
  usage volume that doesn't exist yet (see 4b).
- **P9 (Native runtime hooks into Claude Code/OpenCode's own skill
  loader, bypassing MCP round-trips):** not built. The MCP tool-call
  approach depends on the agent reliably choosing to call
  `resolve_task_sections` — this is a known risk (see §5) that has no
  real-world data confirming or denying it's a problem in practice.

### 4d. Model invocation reliability — never actually tested

The single biggest risk identified early in this project's design
(see the risks doc that predates implementation) was: will an agent
actually call the search/resolve tools reliably, or will it just not
bother, silently reverting to worse-than-baseline behavior? Nothing in
the P0–P6 build tests this — it's a design risk that was mitigated on
paper (fallback-to-whole-file invariant) but never observed against a
real agent's actual tool-calling behavior in a live session.

### 4e. Cross-skill dependency edge cases — only lightly exercised

Only one cross-skill dependency closure has been exercised in testing
(a fixture built specifically to validate the token-savings formula for
that case). Real skill corpora may have more complex cross-skill
dependency patterns than anything tested so far.

### 4f. Scale — untested beyond 3 skills / ~24 sections

Everything has been verified against a small, curated corpus (3 skills,
~16 sections combined). Index size, search latency, and resolver
performance at real-world scale (dozens to hundreds of skills) have not
been measured.

## 5. Known, accepted limitations (not bugs — documented tradeoffs)

- **Session correlation is an approximation.** Follow-up-rate tracking
  is process-local with a 5-minute window; it conflates concurrent
  users if this is ever run as a shared/HTTP deployment, and resets on
  server restart. Explicitly labeled as such in `stats` output.
- **`doctor --diff-preambles`** (comparing shadowed vs. winning safety
  preambles in detail) was scoped as a future addition, not built —
  only the advisory flag that a preamble was shadowed exists today.
- **Native hook integration (Path C)** was designed but never built —
  the system currently only reduces token load if the calling agent
  actually invokes the MCP tools or CLI; it cannot yet transparently
  substitute sections the way a deeper runtime integration could.

## 6. Recommended next step

Not another build phase. Run the system against real usage first:

1. Point a live Claude Code or OpenCode session at this MCP server for
   normal work against a real (not synthetic) skill corpus.
2. Let it accumulate enough calls that `skillsect stats` produces
   non-zero, meaningful `usageSignals`.
3. Re-evaluate whether P7/P8/P9 are actually needed based on that real
   data — not before.

Building further phases now, without that data, would repeat the exact
mistake this project has already caught and corrected once (see §3's
eval-drift note): trusting a number that looks complete but was never
actually measured against reality.
