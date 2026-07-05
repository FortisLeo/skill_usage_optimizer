# MCP Skill Context Optimizer Plan

**Date:** 2026-07-03

## Problem

Full `SKILL.md` loading burns context window — especially upfront when skills are
injected before the agent knows whether it will use them, and when multiple skills
stack in a single session. Agent harnesses auto-inject every matched skill in full,
wasting thousands of input tokens on instructions, examples, and reference material
the current turn will never touch.

## Goal

1. **Preserve context window first.**
2. **Reduce input tokens and improve precision second.**

Token savings are the primary success metric. Precision (loading the right sections
for the current turn) is the secondary metric.

## Product: Skill Compiler MCP

A **compiler-style skill slicer**, not a RAG system.

The MCP server discovers skill artifacts across harnesses, parses markdown into a
structured manifest and section store, classifies sections into deterministic load
classes, extracts mandatory policy, and serves progressive context loads to the
client/wrapper. The client decides what to load; the server compiles and slices.

### What it is NOT

- Not a RAG system (no embeddings, no vector search as core).
- Not a graph database or graph-RAG pipeline.
- Not a semantic reranker or LLM judge.
- Not a GitNexus clone.
- Not an IDE integration.
- Not a skill rewriter — **existing skill files must not be rewritten**.
- Not an auto-summarizer that replaces old context.

## Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Client / Wrapper                     │
│  (calls MCP tools instead of auto-injecting full skills)    │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP tool calls
┌──────────────────────────▼──────────────────────────────────┐
│                    MCP Tools Layer                           │
│  list_skills · resolve_skills · get_skill_manifest          │
│  get_skill_sections · load_section · index_skills           │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  Retrieval Service                           │
│  Context builder · Reference resolver · Token estimator     │
└──────┬───────────────┬──────────────────┬───────────────────┘
       │               │                  │
┌──────▼──────┐ ┌──────▼───────┐ ┌───────▼───────────────────┐
│ Skill Index │ │ Section Store│ │ Lexical Search (BM25-lite)│
└──────┬──────┘ └──────┬───────┘ └───────────────────────────┘
       │               │
┌──────▼───────────────▼─────────────────────────────────────┐
│                   Compiler Pipeline                         │
│  Markdown Parser · Classifier · Policy Extractor           │
│  Manifest Builder · Reference Extractor · Freshness Track  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│               Discovery Adapters + Normalizer               │
│  Claude · OpenCode · Codex · Copilot · Cursor · Roo · ... │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│            Allowlisted Filesystem Roots                      │
│  workspace · repo ancestors · user home · system (opt-in)  │
└────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Automatic Deterministic Classification

Classification is **learned from common skill repo patterns** — heading names,
keywords, structural position — not from ML or LLM judgment. The classifier maps
headings to one of four chunk classes:

| Class | Meaning | Load behavior |
|-------|---------|---------------|
| `always` | Rules, safety, permissions, output contracts, when-not-to-use | Always included in every load |
| `phase` | Workflow steps, process stages | Included when phase matches or likely relevant |
| `on_demand` | Examples, troubleshooting, references, deep-dive | Loaded only on explicit request or lexical match |
| `reference` | Linked files, scripts, assets | Loaded only when explicitly requested or linked from loaded sections |

### Uncertainty Strategy

When the client is unsure which sections are needed:

1. Load `always` sections (mandatory).
2. Load best lexical matches for the current query.
3. Load parent/child neighborhood around matched sections.
4. **Do NOT load the whole skill** unless retrieval failure demands it.

### Runtime Flow

- **Initial retrieval:** `resolve_skills` or `load_skill_context` returns always +
  best matches for the trigger prompt.
- **Progressive/explicit fetches:** `load_section` for specific sections or
  references the agent discovers it needs mid-task.

### Integration Assumption

MCP helps **only if the client/wrapper calls it** instead of auto-injecting full
skills. The MCP server is a tool the harness uses; it does not replace the harness's
skill matching. If the harness keeps auto-injecting, MCP adds latency without
saving tokens.

### Safety: Mandatory Rules Are Never Semantic

Mandatory rules, output contracts, permissions, and when-not-to-use sections
**must not depend on semantic retrieval**. They are:

- Extracted verbatim by the policy extractor (exact snippet matching for
  must/never/always/do not/required/security/validate/test patterns).
- Classified as `always` by the heading classifier.
- Included in every `load_skill_context` response unconditionally.

Semantic search can find additional relevant sections, but it must never gate
safety-critical content.

### Stable IDs and Freshness

- **Section IDs** based on heading path (deterministic slug from heading text).
- **Source hash / mtime** freshness check — quick mtime/size check, hash confirm
  on mismatch.
- **Allowed roots** — only allowlisted filesystem paths scanned. No arbitrary crawl.
- **Reference depth cap** — linked files loaded only up to a configurable depth.

## Minimal MCP Surface

| Tool | Purpose |
|------|---------|
| `list_skills` | Enumerate discovered skills with kind, source system, description |
| `resolve_skills` | Match trigger prompt to candidate skills (lexical) |
| `get_skill_overview` / `get_skill_manifest` | Return manifest: sections, classes, token estimates |
| `get_skill_sections` / `load_skill_context` | Load always + matched sections + neighborhood |
| `load_section` / `get_skill_resource` | Load a specific section or reference by ID |
| `index_skills` | Admin/dev-only or auto-stale rebuild trigger |

### Deferred / Diagnostic Tools

- `list_skill_sources` — show discovery roots and what was found.
- `read_skill` — raw skill content for debugging.
- `resolve_effective_instructions` — merged instruction set for a context.
- `explain_artifact` — why an artifact was classified this way.
- `watch_skill_roots` — freshness monitoring.

### Optional / Future

- `skill://...` resources (lower priority than tools).
- RAG / embeddings / vector search as optional fallback only.

## Non-Goals

- **GitNexus clone** — different problem, different tool.
- **Graph-RAG as core** — over-engineered for deterministic markdown slicing.
- **Embeddings/ML as required infra** — BM25-lite covers the search need.
- **Rewriting skill files** — skills are author-owned; we compile, not edit.
- **Auto-summarizing old context as replacement** — lossy, not needed.
- **IDE integration** — out of scope for the MCP server itself.

## Validation Metrics

| Metric | Target |
|--------|--------|
| Token savings vs full SKILL.md load | Measurable reduction (goal: 50%+ typical) |
| Mandatory rule recall | Near 100% (golden prompt tests) |
| Section precision/recall | High precision, acceptable recall |
| Latency (p50, p95) | Sub-second for typical loads |
| Follow-up fetch count | Low (progressive loading works) |
| False activation / over-fetch | Minimal |

## Open Questions

- Embedding fallback: implement only if BM25-lite precision is insufficient on eval.
- Resource endpoints (`skill://...`): defer until tool surface is proven.
- Multi-skill dedup: same-name skills from different systems are NOT merged.
