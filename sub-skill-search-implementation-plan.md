# Sub-Skill Search — Implementation & Delivery Plan

**Working name:** `skillsect`  ·  **Status:** design → build-ready  ·  **Companion to:** `sub-skill-search-design.md`

---

## TL;DR

- **Problem.** Progressive disclosure in Claude Code / OpenCode stops at the file boundary. The moment a multi-section skill matches (the classic `chrome` skill with *inspect-element*, *login*, *screenshots*, *cookies* all in one file), the **whole** file loads — you pay for sections you never use, on every match.
- **Core move.** Make the **section** the unit of retrieval. Build one small, on-disk, section-level index; keep the existing skill catalog ambient; load only the matched section(s).
- **Shape.** Ship a **runtime-agnostic core library + CLI first**, then an MCP adapter, then optional native hooks. One index, several front-doors — so parsing/indexing/ranking/security is solved once and reused everywhere.
- **No heavy infra.** Default search is keyword (BM25F): no vector DB, no server. Embeddings are an opt-in re-rank, gated on a *measured* miss-rate — not shipped by default.
- **Correctness additions over the original design** (the parts that make section-slicing safe): **shared-preamble handling** so global setup/safety notes are never orphaned, and **anchor + content-hash addressing** so slices stay correct as files change.

```
                    ┌──────────────────────────────┐
                    │      skillsect (core lib)      │
                    │  parse → index → search → slice│
                    └───────────────┬────────────────┘
             ┌────────────────────── ┼ ───────────────────────┐
             │                       │                         │
      ┌──────▼──────┐        ┌───────▼───────┐         ┌───────▼────────┐
      │  CLI binary │        │   MCP server   │        │  Native hook   │
      │ (any host   │        │ (Claude Code,  │        │ (Claude Code / │
      │  that can   │        │  Claude Desktop│        │  OpenCode skill│
      │  shell out) │        │  , any MCP     │        │  loader adapter│
      │  ship 1st   │        │  host) ship 2nd│        │  ) ship last   │
      └─────────────┘        └────────────────┘        └────────────────┘
        all three read/write the SAME on-disk index format
```

---

## 1. What we're fixing

The two-tier model — **Tier 0** catalog scan (name + description of every skill, cheap) → **Tier 1** full-file load on match — is correct for *which skill*. It has no answer for *which part of a skill*. Retrieval granularity stops at the file; content granularity does not. As skills accumulate sections and examples, matched files bloat context linearly with their size, regardless of how little of the file the task needs.

The fix is a third level of granularity — the **section** — added without new heavy infrastructure and working on **both** Claude Code and OpenCode (and any runtime that can shell out or speak MCP).

---

## 2. Design principles

1. **The section is the unit.** Search returns sections; loads pull sections.
2. **Index scales with structure, not prose.** One sentence of metadata per heading — small even at thousands of sections.
3. **Core once, adapters many.** CLI / MCP / native hook are thin skins over one library.
4. **Zero-infra default.** Pure keyword search out of the box. Embeddings are optional and lazy.
5. **File-based, git-friendly, incremental.** Only re-parse changed files; sidecars are readable and diff-able.
6. **Never trade correctness for compactness.** Shared setup context and cross-references must survive slicing.
7. **Security travels with the section.** Trust tier, sanitization, size cap, and a data envelope apply at section granularity, not just file granularity.

---

## 3. Retrieval model — from two hops to one

The original design used three tiers where Tier 1 loads the *matched skill's* `sections.json` into context, then Tier 2 loads a section. That still forces a **two-hop decision** (pick skill → pick section) and still puts a whole `sections.json` in context.

This plan collapses it: keep the catalog ambient, put a **global section index on disk**, and let a single search return the right sections directly (skill is just metadata on each section).

| Level | What lives here | In context? | Size | When |
|-------|-----------------|-------------|------|------|
| Ambient catalog | Skill `name` + `description`, all skills | Yes (unchanged native behavior) | ~1K tokens | Always |
| Section index | Every section as a searchable record | No — on disk | ~a few hundred bytes/section | Queried on demand |
| Loaded section | The actual section text (+ shared preamble) | Yes, on demand | Only what's needed | After a search hit |

**Net effect:** you never place a whole `sections.json` in context, and you don't have to "pick the skill first." When the skill *is* already known, scope the search to it (`--skill NAME`) — a pure narrowing, not a required first hop.

**Is a global index fast enough?** Yes. 200 skills × ~10 sections ≈ 2,000 short records. In-memory BM25 over that is single-digit milliseconds. Skill-name field weighting plus an optional re-rank disambiguates same-named sections across skills.

---

## 4. Indexing pipeline

Build-time, incremental, per-skill. Never mutate or duplicate the original `SKILL.md` — only emit a sidecar next to it.

```
.claude/skills/chrome/
├── SKILL.md
└── .sections.json      ← generated (gitignore or commit, your choice)
```

### 4.1 Parse — fence-aware

Use a fence-aware line scanner (or a real markdown AST). Track state so that **headings are only recognized outside code**:

- Fenced blocks: opened by a run of backticks or tildes; the closing fence must match the same character and be at least as long. Record fence state; ignore everything inside.
- Indented code blocks (4-space) and raw HTML blocks: same — no heading detection inside.

This directly answers *"what granularity is safe to slice mid-file"* — a heading that appears **inside** a fenced block is not a real heading, and section boundaries **snap outward** to the nearest fence boundary so a code block or example is never cut in half.

### 4.2 Section boundaries & granularity

- **Primary unit = `##` (H2).** A section spans from its heading to the next H2/H1, *including* nested `###`+ content.
- **Oversize split.** If an H2 body exceeds `max_section_tokens` (default ~1,500), split into its `###` sub-units — each still carrying the H2 in its `heading_path` breadcrumb. If it has no `###`, keep it whole but set `oversized: true` (surfaced by `doctor`/CI).
- **Tiny sections.** H2s below `min_section_tokens` (~50) are kept as-is (predictable) — they simply rarely win ranking. Merging is available behind a config flag but off by default.
- **No-heading files.** Whole file = one section. This degrades gracefully to today's behavior.

### 4.3 Shared preamble / skill context — *the correctness keystone*

Content **after frontmatter and before the first H2** is the **skill preamble** — e.g. *"always launch Chrome with `--remote-debugging-port=9222`"* or a safety caveat that applies to every operation. Slicing out only the `login` section would silently drop it.

- Store the preamble as a reserved section `__preamble__`.
- On **any** section load, prepend the preamble as a short **Skill setup** block when it's ≤ `preamble_inline_limit` (default ~120 tokens). If larger, prepend a one-line pointer + summary and let the agent pull it explicitly.
- Sections may declare `requires: ["__preamble__", "other-section-id"]` (auto-detected heuristically, or author-marked) so hard dependencies are never orphaned.

### 4.4 Metadata, summary, keywords

For each section, derive automatically (zero authoring effort):

- `id` — slug of the heading path (e.g. `chrome#login`).
- `heading_path` — ancestor headings, used as the breadcrumb on load.
- `summary` — author override if present, else the first sentence under the heading, stripped of markup.
- `keywords` — heading tokens + top TF terms from the body (stopword-filtered) **+ code identifiers extracted from fenced blocks** (function names, CLI flags, API calls). Code identifiers are the highest-signal match for "how do I call *X*."
- `addressing` — `{ start_line, end_line, start_anchor: {text, level}, content_sha256 }`.
- `trust_tier` — inherited from the parent skill's source (bundled / personal / project / marketplace / untrusted).

Optional author override for precision (still zero required effort):

```markdown
## Form Filling
<!-- section-summary: Detect and fill form fields, handle validation errors -->
<!-- section-keywords: input, form, submit, validation -->
```

### 4.5 Sidecar + global index formats

**Per-skill sidecar** — human-readable, git-friendly:

```json
{
  "skill": "chrome",
  "source_hash": "a3f9e1...",
  "schema_version": 1,
  "sections": [
    {
      "id": "login",
      "heading_path": ["Chrome Automation", "Login"],
      "line_range": [61, 96],
      "start_anchor": { "text": "Login", "level": 2 },
      "content_sha256": "9c1d...",
      "summary": "Authenticate against a portal login form and wait for redirect",
      "keywords": ["login", "signin", "credentials", "auth", "waitForNavigation"],
      "trust_tier": "project",
      "requires": ["__preamble__"],
      "oversized": false
    }
  ]
}
```

**Global index** — the search corpus, rebuilt incrementally:

```
.skillsect/
├── manifest.json            ← version + per-skill source_hash map
├── sections.jsonl           ← one section record per line (the corpus)
├── bm25.json                ← optional precomputed postings
├── embeddings.f32           ← optional, only if embedding tier is on
└── embeddings.meta.json     ← optional (dims, model id, offsets)
```

- **Default backend:** load `sections.jsonl` into memory and build BM25 on the fly — fast enough into the low thousands of sections.
- **Optional backend:** SQLite FTS5, triggered when the corpus is large (> ~5K sections) or cold-start latency matters. Same records, different store.

### 4.6 Incremental rebuild & watch

Hash each `SKILL.md`; re-parse only skills whose hash changed; rewrite that skill's sidecar and replace its lines in `sections.jsonl`; bump `manifest.json`. `skillsect watch` re-indexes on save (reuse the file-watcher pattern skills-radar already uses for its catalog) — no restart.

---

## 5. Search & ranking

### 5.1 Field-weighted BM25 (BM25F) — starting weights

| Field | Weight | Why |
|-------|-------:|-----|
| `heading_path` | 3.0 | The strongest human-authored signal of what a section is |
| `keywords` (incl. code identifiers) | 2.5 | Precise task/API terms |
| `skill_name` | 1.5 | Disambiguates same-named sections across skills |
| `summary` | 1.5 | One-sentence intent |
| `body_head` (first ~200 tokens) | 0.5 | Recall backstop |

### 5.2 Boosts

- Exact phrase match in `heading_path`/`summary`: ×1.5.
- Query token equals an indexed **code identifier**: strong boost (this is what makes "call `waitForNavigation`" land on the right section).
- **Session cohesion:** small boost for sections whose skill is already active in the current session.

### 5.3 Optional embedding re-rank (opt-in, lazy)

Invoke **only** on genuine ambiguity — when `top1 − top2 < margin` (default ~15%). Embed section **summaries** (one sentence each, so the vector index is trivially small even at thousands of sections), re-rank the top-K (K ≤ 20) by cosine with a small local model. Off by default; enabled only when data justifies it (see §9).

### 5.4 Confidence & fallback

Return a normalized confidence with each result. If the top score is below `confidence_floor`, the response says *"low confidence — consider loading the full skill"* so the agent can safely fall back to whole-file behavior. Log `(query → top results → which section was loaded)` locally for the eval loop.

---

## 6. Loading a section (robust slicing)

1. **Resolve by anchor + hash first**, treating `line_range` as a hint. If `content_sha256` matches → slice those lines. If not (the file was edited since indexing) → re-find the heading by its anchor text, re-slice, and mark the skill **stale** so the next pass re-indexes it. This is self-healing and removes the fragility of raw line ranges.
2. **Prepend the breadcrumb** (`chrome › Chrome Automation › Login`) and the preamble / pointer per §4.3.
3. **Wrap the content in a data envelope** (see §7) so the agent treats it as reference material, not instructions to obey.

---

## 7. Security — carried forward at section granularity

A section is executable-instruction text just like a full skill file, so the defenses skills-radar established apply per-section:

- **Trust tiers propagate** file → section (bundled / personal / project / marketplace / untrusted).
- **Sanitize on load** — strip or escape injection-style control markup **in prose**, but **never mutate fenced code** (that would corrupt legitimate examples). Suspicious code is *flagged*, not rewritten.
- **Per-section size cap**, independent of the parent file's overall cap.
- **Data envelope** — return sections inside a clearly delimited "reference data" wrapper so the model treats them as material rather than commands.
- **Preamble-as-safety** — because a section can be pulled out of its file, any security-relevant preamble is `always_include`. Net, section retrieval *reduces* injection surface (less text loaded) but must never orphan a warning that lived in a sibling section.

---

## 8. Integration paths

### Path A — CLI (build first; works everywhere)

A single binary/script. Both Claude Code and OpenCode invoke arbitrary shell commands during normal tool use, so this needs **zero** plugin-API work and validates the core library immediately.

```
skillsect index  [--path DIR] [--force] [--embed] [--backend jsonl|sqlite]
skillsect search "<query>" [--skill NAME] [--k N] [--min-score S] [--json]
skillsect get    <skill>#<section> [--no-preamble] [--raw]
skillsect watch  [--path DIR]
skillsect stats            # corpus size, section counts, miss-rate, oversized flags
skillsect doctor           # validate index, report unsplit/oversized sections, stale skills
```

`search` output (Tier-1 result — cheap, just pointers):

```json
{
  "query": "log into the portal in chrome",
  "results": [
    { "skill": "chrome", "section_id": "login",
      "heading_path": ["Chrome Automation", "Login"],
      "summary": "Authenticate against a portal login form and wait for redirect",
      "line_range": [61, 96], "score": 0.87, "confidence": "high" }
  ],
  "low_confidence": false
}
```

`get` output (Tier-2 — only the slice, breadcrumbed and enveloped):

```
[skill: chrome | Chrome Automation › Login | trust: project]
--- skill setup (shared) ---
Launch Chrome with --remote-debugging-port=9222 before any step.
--- section ---
<the Login section text, verbatim>
```

Exit codes: `0` hit · `2` no result above `--min-score` · `3` index missing/stale · `4` parse/config error.

### Path B — MCP server (extends reach to any MCP host)

Wrap the same core as two tools (plus an optional `list_skills`), following the proven search-then-load pattern.

**`search_skill_sections`**
> *Search across all installed skill files for the specific section(s) relevant to the current task, instead of loading a whole skill. Returns ranked sections with their skill, heading path, and a one-line summary. Use this when a task matches a skill but you only need part of it, or when you're unsure which skill/section covers the task.*
> Input: `{ query: string, skill?: string, k?: number }` → Output: array of `{ skill, section_id, heading_path, summary, score, line_range }`.

**`load_skill_section`**
> *Load the full text of one section returned by `search_skill_sections`. Returns only that section plus its skill's shared setup context. Prefer this over reading the entire skill file.*
> Input: `{ skill: string, section_id: string, include_preamble?: boolean }` → Output: `{ heading_path, content, trust_tier, source, preamble? }`.

Typical flow: model calls `search_skill_sections("fill the signup form")` → gets `chrome#form-filling` → calls `load_skill_section("chrome", "form-filling")` → proceeds. Same core library, so ranking/security fixes land here for free. Works with Claude Code, Claude Desktop, Claude.ai connectors, and any MCP client.

### Path C — Native hook (deepest integration; defer)

Both runtimes already run a Tier-0→1 discovery pass internally. A thin adapter per runtime (a Claude Code plugin hook; an OpenCode equivalent) can intercept the moment a skill is selected and, if a `.sections.json` sidecar exists, substitute **matched sections only** for the full body — invisible to the model, with **no extra tool round-trip**. Highest long-term value, but it means maintaining two adapters against two evolving plugin surfaces. Build only once usage data shows the A/B round-trip is a real bottleneck.

**Recommendation:** A first (proves the core, usable by both ecosystems with no integration work) → B once A's retrieval quality is validated (any MCP host) → C only if the extra round-trip is measurably slowing things down.

---

## 9. Evaluation & metrics

- **Labeled eval set.** Representative multi-section skills + realistic task queries → expected section(s). Keep it in-repo.
- **Metrics.** precision@1, precision@3, recall@3, **miss-rate** (top result below `confidence_floor`), and **context-saved** (tokens loaded vs. the whole-file baseline — this is the headline win).
- **Gate on data.** Ship BM25F; instrument miss-rate; enable the embedding tier **only** if the observed miss-rate warrants it. (This turns the source doc's "measure before adding complexity" into an actual gate.)
- **CI check.** Index builds clean, schema valid, no `oversized`/unsplit sections without a flag, no stale skills.
- **Privacy.** Query/selection logs stay local; never uploaded.

---

## 10. Performance targets

Framed as targets to validate, not measured results:

- **Cold build:** parse ~1 MB of markdown well under a second; a few hundred skills in a couple of seconds.
- **Incremental:** one changed `SKILL.md` re-indexed in milliseconds.
- **Search:** in-memory BM25F over a few thousand sections — single-digit ms; with embedding re-rank on top-K (warm model) — tens of ms.
- **Index size:** scales with *sections*, not content — a few hundred bytes/section → a few hundred KB at ~1,000 sections. Embeddings are optional and stored separately.

---

## 11. How to use it

### Setup (CLI — either runtime)

1. Install `skillsect`.
2. Run `skillsect index --path <your skills root>` (e.g. `.claude/skills` or your OpenCode skills dir). Optionally `skillsect watch` to keep it live.
3. Add a short rule to your agent's instructions file so it prefers section search over whole-file reads:

> *When a task matches a skill, first run `skillsect search "<task>"` and load only the returned section with `skillsect get <skill>#<section>`. Read the whole `SKILL.md` only if the search returns low confidence.*

### Claude Code

- **CLI path (no setup):** the model just calls the shell tool; add the rule above to `CLAUDE.md`.
- **MCP path:** register the `skillsect` MCP server in your MCP config; the tools appear as `search_skill_sections` / `load_skill_section`.

### OpenCode

- **CLI path:** identical shell approach; add the rule to your OpenCode agent rules/config.
- **MCP path:** register the `skillsect` MCP server in OpenCode's MCP config.

### Before / after (the `chrome` skill)

Task: *"log into the portal in Chrome."*

- **Before:** the whole `chrome` skill loads — *login* **plus** inspect-element, screenshots, and cookie handling — all into context.
- **After:** `search` returns `chrome#login` (+ the shared launch-flags preamble), `get`/`load` pulls just that slice; the other three sections never enter context. Same for `form-filling`, `screenshots`, etc. — each task pays only for what it uses.

---

## 12. Phased delivery plan (milestones + go/no-go gates)

| Milestone | Deliverable | Gate to pass before next |
|-----------|-------------|--------------------------|
| **M0 — Core** | Fence-aware parser, section boundaries, preamble handling, anchor+hash addressing, slicer | Correct boundaries + no split code blocks on the test corpus |
| **M1 — Search + CLI** | BM25F ranking, `index`/`search`/`get`, JSON output | precision@3 ≥ target on eval set; context-saved measured & positive |
| **M2 — Live index** | `watch`, incremental rebuild, `stats`, `doctor` | Incremental result identical to a full rebuild |
| **M3 — MCP adapter** | `search_skill_sections`, `load_skill_section` (+ `list_skills`) | Parity with CLI results inside a live MCP host |
| **M4 — Embeddings** *(conditional)* | Lazy re-rank on score-margin ambiguity | Only if measured miss-rate warrants it |
| **M5 — Native hooks** *(conditional)* | Claude Code + OpenCode skill-loader adapters | Only if the A/B round-trip is a proven bottleneck |

---

## 13. Open questions — recommended answers

1. **Does automatic heading-based splitting produce useful boundaries, or do authors need the override?** → Default to automatic; ship the `section-summary`/`section-keywords` overrides for terse or ambiguous headings. Expect overrides to matter mainly where headings are one vague word. Confirm via the eval set rather than guessing.
2. **What line-range granularity is safe to slice mid-file?** → Solved structurally: fence-aware boundary snapping + never-split-inside-a-fence + anchor+hash re-validation on load. H2-primary, with H3 split only on oversize.
3. **Does pure BM25 suffice, or is the embedding tier necessary?** → Ship BM25F, instrument miss-rate, and add embeddings **only** if the data says so. Treat the embedding tier as a switch, not a default.

**New questions worth flagging:**
- Tuning `preamble_inline_limit` — how much shared context to inline vs. pointer.
- Heavily cross-referencing skills ("see the section above") — consider a lightweight `see_also` graph so a matched section can surface its immediate neighbors.

---

## Appendix A — Schemas

**`.sections.json`**
```
skill: string
source_hash: string
schema_version: integer
sections: [ {
  id: string                 # "<skill>#<slug>"
  heading_path: string[]
  line_range: [int, int]     # hint only; validated against hash on load
  start_anchor: { text: string, level: int }
  content_sha256: string
  summary: string
  keywords: string[]
  trust_tier: "bundled"|"personal"|"project"|"marketplace"|"untrusted"
  requires: string[]         # e.g. ["__preamble__"]
  oversized: boolean
} ]
```

**`.skillsect/manifest.json`**
```
schema_version: integer
generated_at: iso8601
backend: "jsonl" | "sqlite"
embeddings: boolean
skills: { "<skill>": { source_hash: string, section_count: int, stale: boolean } }
```

**MCP tool I/O**
```
search_skill_sections
  in : { query: string, skill?: string, k?: number }
  out: [ { skill, section_id, heading_path, summary, score, line_range } ]

load_skill_section
  in : { skill: string, section_id: string, include_preamble?: boolean }
  out: { heading_path, content, trust_tier, source, preamble? }
```

## Appendix B — Default knobs (one place to tune)

| Knob | Default | Meaning |
|------|--------:|---------|
| `max_section_tokens` | 1500 | Above this, split H2 into H3 units (or flag `oversized`) |
| `min_section_tokens` | 50 | Below this, keep as-is (merge only if configured) |
| `preamble_inline_limit` | 120 | Inline shared preamble up to this size, else pointer |
| BM25F weights | 3.0 / 2.5 / 1.5 / 1.5 / 0.5 | heading_path / keywords / skill_name / summary / body_head |
| embedding margin | 0.15 | Trigger re-rank when top1−top2 is within this |
| `confidence_floor` | tune on eval | Below this, advise whole-file fallback |
| SQLite backend trigger | ~5000 sections | Switch storage backend above this corpus size |
