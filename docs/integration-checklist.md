# Integration Checklist

## Pre-Merge Checks

### Track A — Discovery + Normalizer

- [ ] All discovery adapters (Claude, OpenCode, Codex, Copilot) return artifacts from fixtures
- [ ] Normalizer produces consistent `NormalizedSkillInput` shape across all harnesses
- [ ] Allowlisted roots enforced — no reads outside configured paths
- [ ] Freshness tracker detects mtime/size changes and flags stale entries
- [ ] Symlinks and missing roots handled without crashing

### Track B — Compiler + Retrieval

- [ ] Markdown parser handles headings, nested sections, code fences, frontmatter
- [ ] Classifier assigns every section to exactly one class: `always`, `phase`, `on_demand`, `reference`
- [ ] Policy extractor captures mandatory rules (must/never/always/do not/required/security)
- [ ] Manifest builder emits stable section IDs (deterministic slug from heading path)
- [ ] Reference extractor resolves linked files within allowed roots
- [ ] Token estimator returns reasonable counts per section
- [ ] `load_skill_context` always includes `always` sections
- [ ] `load_skill_context` includes relevant `phase`/`on_demand` sections for the query
- [ ] `load_section` returns exact section content by ID
- [ ] `resolve_skills` lexical matching returns correct candidates
- [ ] Token/context selection policy applied during retrieval
- [ ] Compile conflicts emitted as `CompileResult.diagnostics` (non-fatal), not as `BoundaryError` in `errors`
- [ ] `SkillConflictDiagnostic` includes winner, shadowed sources, reason, and winner precedence
- [ ] Compiler picks winner by precedence; tiebreak is deterministic and documented

### Track C — Store + MCP Tools

- [ ] `list_skills` returns summaries (name, kind, source system, description)
- [ ] Stale index triggers rebuild or returns rebuild signal
- [ ] All tools reject unsafe paths (traversal, absolute outside roots)
- [ ] Store persists `SkillManifest.precedence` and `SkillManifest.conflicts` when present
- [ ] Store persists `CompileResult.diagnostics` alongside the compiled index
- [ ] MCP tool responses expose precedence and conflict diagnostics to clients

## Integration Smoke Tests

| # | Test | Expected |
|---|------|----------|
| 1 | Fixture scan returns expected artifacts | Each fixture dir yields ≥1 skill per harness adapter |
| 2 | Compile returns stable manifests/sections | Same input → same section IDs, same classes, same token counts |
| 3 | Store roundtrip loads same index/sections | Serialize → deserialize → identical manifest and section content |
| 4 | `list_skills` returns summaries | Each entry has name, kind, source, description; no full content |
| 5 | `load_skill_context` includes `always` + relevant `phase`/`on_demand` | Always sections present unconditionally; matched sections present for query |
| 6 | `load_section` returns exact section | Content matches source markdown between heading boundaries |
| 7 | Unsafe path fixture rejected | `../../etc/passwd` and absolute paths outside roots → error, no read |
| 8 | Stale file rebuild detected | mtime change → index marked stale → rebuild on next access |

## Eval Gates

| Gate | Threshold | How measured |
|------|-----------|--------------|
| Mandatory rule recall | ≈100% on fixtures | Golden prompts with known rules → all extracted rules present in `always` sections |
| Token savings vs full SKILL.md | >50% typical reduction | `load_skill_context` token count / full SKILL.md token count per skill |
| No arbitrary filesystem reads | Zero violations | Unsafe path fixtures rejected; all reads within allowlisted roots |
| No embeddings/RAG/graph DB dependency | Zero introduced | No embedding model, vector index, or graph DB in dependency tree or runtime path |

## Final Connection Points

| Connection | From | To | Status |
|------------|------|----|--------|
| Discovery → Compiler | Track A adapters | Track B pipeline | Normalized artifacts feed parser |
| Compiler → Store | Track B output | Serialized index | Manifest + sections persisted |
| Store → Retrieval | Serialized index | Track B retrieval | Loaded on each MCP call |
| Freshness → Rebuild | Track A freshness | Track B compiler | Stale flag triggers recompile |
| MCP tools → Client/wrapper | Track C surface | Harness integration | Client calls tools instead of auto-inject |

## Ownership

| Area | Owner | Scope |
|------|-------|-------|
| Track A — Discovery + Normalizer | Track A | Adapters, roots, freshness, normalization |
| Track B — Compiler + Retrieval | Track B | Parser, classifier, policy extractor, manifest, references, token/context selection policy, lexical search, retrieval/loadContext |
| Track C — Store + MCP + Eval | Track C | Store/persistence, MCP schemas/tools/server, integration + eval harness |
| Eval + Smoke Tests | Track C | Fixture design, golden prompts, gate enforcement |
| Client/Wrapper Integration | Track C | Harness-side calls replacing auto-inject |
