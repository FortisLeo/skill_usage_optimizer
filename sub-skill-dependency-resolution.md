# Sub-Skill Dependency Resolution — Design

**Working name:** `skillsect` (resolver layer)  ·  **Status:** design → build-ready  ·  **Extends:** `sub-skill-search-implementation-plan.md`

> Assumes the section-level system already exists: sections parsed from `SKILL.md`, per-skill `.sections.json` sidecars, a global section index, BM25F search, shared-preamble handling, and anchor+hash addressing. This document adds the missing piece: retrieving the **connected cluster** of sections a task needs — not just the single best match.

---

## TL;DR

- **The gap.** Section retrieval returns *isolated* sections. Some tasks need several sub-skills working together (fill the form = detect fields → fill → handle validation → submit, each a separate section). Return only the top match and the task fails.
- **The trap.** The fix must thread between **under-retrieval** (miss a needed section → task fails) and **over-retrieval** (pull everything related → you've reloaded the whole file and thrown away section-level retrieval entirely).
- **Mental model — a package manager for skill sections.** Search *finds* the package; **resolve** computes its dependency tree and installs the **minimal closure**, not the world.
- **Model sections as a typed dependency graph:** `requires` (hard — always included, ordered), `related` (soft — budgeted, offered), plus optional `flow` meta-nodes (named ordered recipes — the clean answer to "fill the form").
- **Four anti-over-retrieval valves:** a token **budget**, **collapse-to-whole-file** when the closure ≈ the whole file anyway, a soft-edge **confidence threshold**, and a progressive "**N more related available**" footer.
- **Edges come from** author declarations (primary, trusted) → auto-inference (cross-references + shared code symbols + step headings; soft by default) → usage learning (optional, later). Author always wins.
- **Nothing regresses.** An independent sub-skill has an empty closure and behaves exactly as it does today.

---

## 1. The gap, precisely

Retrieval granularity now reaches the section, but **task granularity doesn't stop at one section.** Tasks come in two shapes:

- **Independent sub-skill** — served by one section. "Take a screenshot" needs the screenshot section and nothing else. ✔ already works.
- **Dependent / correlated sub-skill** — the matched section can't stand alone; it needs companions. Return only the seed and the agent is missing the sections the task depends on.

Within the dependent case there's a real distinction:

| | Meaning | Example | Must include? | Ordered? |
|---|---|---|---|---|
| **Hard dependency** | A cannot run without B | `submit` needs `detect-fields` first; every step needs the launch-flags preamble | Always | Yes |
| **Soft correlation** | A is usually used with B, not blocked without it | `fill-fields` + `handle-validation` | Only if it fits the budget | No |

```
Independent:            Dependent (a connected cluster):

   ┌────────────┐          ┌──────────────┐   requires   ┌──────────────┐
   │ screenshot │          │ detect-fields │◀────────────│ fill-fields  │
   └────────────┘          └──────────────┘              └──────┬───────┘
   return this, alone                                     related│  requires
                                                    ┌────────────▼──┐  ┌────▼─────┐
                                                    │handle-validation│  │  submit  │
                                                    └─────────────────┘  └──────────┘
                          return the minimal set that completes the task — no more
```

The two failure modes to avoid simultaneously: **under-retrieval** (cluster incomplete → task fails) and **over-retrieval** (cluster = whole file → point of section retrieval lost).

---

## 2. Mental model — a package manager for sections

The whole design maps onto dependency resolution, which is well understood:

| Package manager | This system |
|---|---|
| Package | Section |
| Dependency (`dependencies`) | `requires` edge (hard) |
| Optional / suggested dep | `related` edge (soft, weighted) |
| Meta-package / bundle | `flow` node (named ordered recipe) |
| `install` computing the tree | `resolve` computing the closure |
| `node_modules` bloat | Over-retrieval |
| Lockfile (resolved, ordered) | The assembled section bundle |
| Version conflict | Cycle in hard deps |

So: **search** answers *which package*; **resolve** answers *what must come with it*; the **budget** is what stops you installing the world.

---

## 3. The section dependency graph

### 3.1 Node types

- **Section** — a real slice of a `SKILL.md`, as today.
- **Flow** — a named, ordered recipe that expands to a list of member sections (§6). Optional; searchable in its own right.

### 3.2 Edge types

| Edge | Hardness | Included by resolver | Carries order | Auto-inferable |
|---|---|---|---|---|
| `requires: [...]` | Hard | Always (transitive closure) | Yes (prerequisite-first) | Only on a strong signal |
| `related: [{id, weight}]` | Soft | Only if it clears threshold **and** fits budget | No | Yes (soft by default) |

### 3.3 Guarantees

- **Hard is a promise:** every transitive `requires` target is in the bundle, ordered so prerequisites appear first. This kills under-retrieval for the true blockers.
- **Soft is an offer:** high-scoring correlated sections are added *while budget allows*; the rest are named in a footer so the agent can pull more on demand. This bounds over-retrieval.
- **The shared preamble** (from the prior design) is modeled as a **universal hard `requires` target** — every section implicitly requires `__preamble__`, so global setup/safety is never orphaned.

---

## 4. Where the edges come from

### 4.1 Author-declared — primary, trusted

Explicit markers in the section (or its heading block). Zero infra, unambiguous, highest trust:

```markdown
## Submit
<!-- requires: detect-fields, fill-fields -->
<!-- related: handle-validation:0.8, retry-on-timeout:0.5 -->
```

### 4.2 Auto-inferred — zero-effort, soft by default

Derived at index time so unannotated skills still get *candidate* edges (confidence-scored, **soft** unless a strong signal promotes them):

- **Cross-references** — intra-doc links and heading mentions ("see the *Field Detection* section", "first run the steps above") → candidate edges.
- **Shared code symbols** — reuse the code-identifier extraction the indexer already does. If section B's code *calls* a symbol *defined* in section A, that's a strong dependency signal. **Promote to hard** only when the symbol has exactly one definition in the skill and is actually called (not merely mentioned) in B; otherwise keep soft.
- **Step / ordinal cues** — "Step 1 / Step 2", "Prerequisites", "Before you begin" headings → ordering + requirement hints.

### 4.3 Usage-learned — optional, later

Log which sections are loaded together in *successful* completions; co-occurrence strengthens `related` weights over time. Powerful but needs telemetry and time — gate it exactly like the embedding tier was gated (opt-in, only when data justifies it). Logs stay local.

### 4.4 Precedence

**Author > learned > inferred.** An author declaration always overrides or upgrades an inferred edge; inference never downgrades an author edge.

---

## 5. Resolution algorithm

### 5.1 Core procedure

```
resolve(query, budget):
  seeds = search(query).top_matches          # BM25F seeds; 1, or a few if scores tie
  if seeds.top is a flow:                     # §6 shortcut
      return expand_flow(seeds.top)           # pre-ordered, author-blessed members

  # 1. HARD closure — mandatory, prevents under-retrieval
  hard = {}
  for s in seeds: hard ∪= transitive_requires(s)   # includes __preamble__
  groups = collapse_cycles(hard)              # mutual requires → co-required group + flag
  ordered = topological_sort(groups)          # prerequisites first; stable by doc order

  # 2. COLLAPSE valve — the honest escape hatch
  if tokens(ordered) >= COLLAPSE_RATIO * tokens(whole_file(seed.skill)):
      return whole_file(seed.skill)           # skill is evidently cohesive; whole file is safer & barely costlier

  # 3. SOFT expansion — budgeted + thresholded, prevents over-retrieval
  spent = tokens(ordered)
  soft_candidates = related_neighbors(ordered)
                      .score(edge_weight * seed_relevance * query_overlap)
                      .filter(score >= SOFT_THRESHOLD)
                      .sort(desc)
  chosen_soft = greedily take while (spent + tokens(next) <= budget); track leftovers

  # 4. ASSEMBLE
  return bundle(preamble, ordered (hard), chosen_soft (marked optional),
                footer = leftovers.ids)       # "N more related available"
```

### 5.2 The four valves (how the needle is threaded)

1. **Budget** — a hard token ceiling on the whole bundle. Soft additions stop when it's hit.
2. **Collapse-to-whole-file** — if the *hard* closure already approaches the whole file (`COLLAPSE_RATIO`, default ~0.7), just load the whole file. Cheaper, safer, and an explicit admission that some skills are genuinely one unit.
3. **Soft threshold** — only high-confidence correlated sections are eligible; noise from auto-inference is filtered out.
4. **Progressive footer** — leftover related sections are *named, not loaded*. The default stays minimal; the agent pulls more only if it needs to. Progressive disclosure, now *within* the cluster.

### 5.3 Ordering

Topological sort on the prerequisite DAG → prerequisites first. Ties broken by document order (stable, predictable). A co-required group (from a cycle) is emitted together with internal order = document order.

### 5.4 Edge cases

| Case | Handling |
|---|---|
| **Cycle** in hard deps (A⇄B) | Treat as a single **co-required group** (include both, no strict internal order); flag via `doctor` |
| **Diamond** (A→B, A→C, B→D, C→D) | Standard closure dedupe — D included once |
| **Dangling target** (`requires: X`, X missing) | Skip gracefully, note in output, flag via `doctor` — never crash |
| **Explosion** (closure balloons, esp. cross-skill) | Budget + collapse valve + cross-skill cap (§7) |
| **Over-broad flow** (15 steps) | Same budget rules + progressive footer |

---

## 6. Flows — the ergonomic top layer

A **flow** is a named, ordered recipe: essentially an author-blessed, pre-computed closure. It's the cleanest answer to "fill the form."

```markdown
<!-- flow: submit-form
     summary: Detect, fill, validate and submit a web form end to end
     steps: detect-fields, fill-fields, handle-validation, submit
-->
```

- The flow is **searchable** (its name + summary + step summaries are indexed), so "fill the form" / "submit the form" ranks the flow highly.
- On a flow match, `resolve` **short-circuits** — it returns the ordered members directly, no edge walking, guaranteed order.
- Flows are **optional sugar.** Where an author declares one, it wins for that entry point. Where none exists, the `requires` + symbol-inference machinery assembles the closure bottom-up automatically. Top-down convenience with a bottom-up safety net.

---

## 7. Cross-skill dependencies

In scope, but deliberately constrained — a cross-skill hard dep pulling in another skill's whole cluster is precisely the over-retrieval risk.

- **Author-declared hard edges may cross skills** (`requires: otherskill#section`) and resolve across the boundary.
- **Auto-inferred cross-skill edges are soft-only**, with a **higher confidence threshold** — a skill can never silently, forcibly inject another skill's content as a hard dep.
- **Trust = the lower of the two tiers.** A section pulled as a cross-skill dependency inherits the *stricter* trust tier of the pair.
- **Cap** on cross-skill closure size (count + tokens), independent of the in-skill budget.

---

## 8. Security additions

Building on the prior design's per-section defenses (trust tiers, sanitize-prose-not-code, per-section size cap, data envelope):

- **Every pulled section stays enveloped** as reference data — dependencies don't become instructions to obey.
- **Closure size cap** (max sections + max tokens) independent of the per-section cap — a malicious or broken dep chain can't balloon context.
- **Cross-skill hard edges are author-only** (never auto-promoted) and inherit the lower trust tier; a malicious `requires` only pulls *enveloped, capped* content.
- **`doctor` validates the graph** — reports cycles, dangling targets, and cross-trust edges (e.g., an untrusted skill pulling from a project skill) for review.

---

## 9. Index & storage changes

Extend the existing artifacts; no new heavy infra.

- **`.sections.json`** — each section gains `requires`, `related`, `provides` (defined symbols), `uses` (called symbols); flow nodes are added as records.
- **`symbols.json`** (new) — `symbol → { defined_in: section_id, used_in: [section_id] }`, the source of def→use inference.
- **Global index** — precompute an **adjacency map** (`edges.json`, or fold into `sections.jsonl`) so `resolve` is a graph walk over in-memory data, not repeated file reads.
- **Incremental** — when a `SKILL.md` changes, re-derive only *its* outgoing edges + symbols; inbound cross-skill edges are stable until those files change.

```json
{
  "id": "submit",
  "heading_path": ["Chrome Automation", "Submit"],
  "requires": ["detect-fields", "fill-fields", "__preamble__"],
  "related": [{ "id": "handle-validation", "weight": 0.8, "source": "author" }],
  "provides": ["submitForm"],
  "uses": ["detectFields", "fillFields"],
  "flow_of": ["submit-form"]
}
```

---

## 10. API / integration changes

### CLI

```
skillsect resolve "<query>" [--skill NAME] [--budget N] [--no-soft] [--json]
     → ordered cluster: { seed, hard[], soft[], leftovers[], collapsed?:bool }
skillsect get <skill>#<section> --with-deps     # single get, auto-includes hard closure
skillsect graph <skill> [--section ID]          # inspect/print the edge graph (debug/author aid)
skillsect doctor                                # + cycles, dangling targets, cross-trust edges
```

`resolve` output (the bundle the agent consumes — ordered, minimal, self-contained):

```json
{
  "query": "fill and submit the form",
  "seed": "chrome#submit",
  "matched_flow": "submit-form",
  "collapsed": false,
  "sections": [
    { "id": "chrome#detect-fields", "role": "hard", "order": 1 },
    { "id": "chrome#fill-fields",   "role": "hard", "order": 2 },
    { "id": "chrome#handle-validation", "role": "soft", "order": 3 },
    { "id": "chrome#submit",        "role": "hard", "order": 4 }
  ],
  "leftovers": ["chrome#retry-on-timeout"],
  "budget": { "limit": 2500, "used": 1840 }
}
```

### MCP

Add one tool; keep the existing two.

**`resolve_task_sections`**
> *Given a task, return the complete, ordered set of skill sections needed to do it — the matched section plus its hard dependencies (and high-value related sections within budget). Use this instead of `search_skill_sections` + repeated `load_skill_section` when a task may span several parts of a skill (a multi-step workflow like filling and submitting a form).*
> Input: `{ query: string, skill?: string, budget?: number, include_soft?: boolean }`
> Output: `{ seed, sections: [{ id, heading_path, content, role, order, trust_tier }], leftovers, collapsed }`

`search_skill_sections` and `load_skill_section` remain for single-section needs.

### Native hook

The Path-C adapter substitutes the **resolved cluster** (not just one section) for the skill's file body — the ordered, budgeted bundle, invisibly, with no extra round-trip.

---

## 11. Evaluation

The metrics change to measure *cluster* quality, not single-hit quality:

- **Dependency recall** — fraction of the truly-needed sections included. Target **1.0** (no under-retrieval).
- **Over-retrieval ratio** — `tokens(returned) / tokens(actually needed)`. Target **near 1.0** (little waste).
- **Ordering correctness** — prerequisites precede dependents.
- **Task completion** — did the bundle let the agent finish?

Eval set: tasks labeled with their **full** required section set *and order* (not just the seed). Ablations: author-declared only → +inferred → +learned. Gate inference-promotion-to-hard and the learned tier on measured recall — don't ship them until the data asks for them.

---

## 12. Phased delivery (extends M0–M5)

| Phase | Deliverable | Gate |
|---|---|---|
| **D1 — Edges + closure** | `requires`/`related` (author-declared), transitive closure, topo-sort, budget, collapse valve, `resolve` CLI | Dependency recall = 1.0 on authored eval skills; over-retrieval ratio near 1.0 |
| **D2 — Auto-inference** | Cross-ref + symbol def/use + step-heading edges (soft; conservative hard promotion), `symbols.json` | Inferred edges match author intent on the eval set |
| **D3 — Flows** | `flow` nodes, searchable, short-circuit expansion | "Workflow" queries resolve to the correct ordered members |
| **D4 — Learned** *(conditional)* | Co-load telemetry strengthens `related` | Only if D1–D3 miss-rate warrants it |

Cross-skill: author-declared hard edges from **D1**; auto-inferred soft cross-skill edges from **D2** (higher threshold). MCP `resolve_task_sections` lands with D1; native-hook cluster substitution follows the prior plan's M5.

---

## 13. Open questions — recommended answers

1. **How aggressively should symbol def→use promote to *hard*?** → Default **soft**; promote only when the symbol has a single definition in the skill *and* is actually called in the dependent section. Measure via dependency recall.
2. **Should soft expansion be on by default?** → **Yes, but tightly budgeted + thresholded + progressive-footer.** Your core complaint is under-retrieval, so lean slightly generous with *high-confidence* soft deps while the four valves cap the downside. Tune against the over-retrieval ratio.
3. **`COLLAPSE_RATIO` and `budget` defaults?** → Start `COLLAPSE_RATIO ≈ 0.7`, `budget ≈ min(0.7 × whole_file, 2500 tokens)`; both are knobs to tune on the eval set.
4. **Auto-promote cross-skill hard deps ever?** → **No.** Cross-skill hard edges are author-only, permanently.

---

## Appendix A — Extended schema (additions only)

```
section (added fields):
  requires: string[]                       # hard dep ids (may be "otherskill#id")
  related:  [{ id: string, weight: 0..1, source: "author"|"inferred"|"learned" }]
  provides: string[]                       # symbols defined here
  uses:     string[]                       # symbols called here
  flow_of:  string[]                       # flows this section is a member of

flow (new node):
  id: string
  summary: string
  steps: string[]                          # ordered member section ids

symbols.json:
  { "<symbol>": { defined_in: "<section_id>", used_in: ["<section_id>", ...] } }

resolve output:
  { query, seed, matched_flow?, collapsed: bool,
    sections: [{ id, heading_path, content, role: "hard"|"soft", order, trust_tier }],
    leftovers: string[], budget: { limit, used } }
```

## Appendix B — Default knobs (additions)

| Knob | Default | Meaning |
|---|---:|---|
| `budget` (cluster tokens) | min(0.7 × whole_file, 2500) | Ceiling for the whole assembled bundle |
| `COLLAPSE_RATIO` | 0.70 | If hard closure ≥ this × whole file, load the whole file instead |
| `SOFT_THRESHOLD` | tune on eval | Minimum score for a soft/`related` section to be eligible |
| symbol→hard promotion | single-def + called | When an inferred symbol edge becomes hard |
| cross-skill auto edges | soft-only, higher threshold | Auto-inference never crosses skills as a hard dep |
| closure size cap | count + tokens | Hard ceiling independent of per-section cap |
