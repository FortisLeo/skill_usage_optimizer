# TypeScript MCP Implementation Plan

**Date:** 2026-07-03
**Origin:** docs/skill-context-mcp-plan.md

## 1. Context and Product Scope

**Product:** Skill Compiler MCP — a compiler-style progressive-disclosure
retrieval server for agent skill files. NOT RAG, NOT graph-RAG, NOT
embeddings, NOT vector DB, NOT core graph traversal.

**Goal:** Given a user request, return the minimum skill context the agent
needs — header first, body on demand, references only when cited — with
deterministic IDs, deterministic freshness, and zero embedding cost.

**Scope boundary:**
- IN: discovery of skill files across supported agent ecosystems,
  normalization, markdown parsing, classification, compilation into a
  manifest + section index, progressive retrieval via MCP tools.
- OUT: semantic search, embeddings, vector indices, graph traversal,
  cross-session learning, model inference.

## 2. Research Grounding

| System | URL / Path | Notes |
|---|---|---|
| Claude Code skills | `~/.claude/skills/**/SKILL.md` | Local SKILL.md convention |
| Claude plugins | `<plugin-root>/skills/**/SKILL.md` | Plugin-scoped skills |
| OpenCode | `.opencode/skills/**/SKILL.md` | Repo + user config paths |
| Codex | `/etc/codex/skills/**` | System-level skills |
| VS Code Copilot | `.github/instructions/**/*.instructions.md` | Workspace instructions |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules` | Rule files + legacy |
| Roo | `.roo/skills*`, `.roo/rules*` | Skills + rules dirs |
| Cline | `.clinerules`, `.clinerules/**/*.md`, `~/Documents/Cline/Rules` | Rules dir + legacy |
| Continue | `.continue/rules/*.md` | Rules directory |
| Aider | `.aider*` conventions | Convention-based |
| GitHub Skills | `.github/skills/**` | Repo-scoped skills |
| Windsurf | `.windsurfrules` | Single-file rules |
| Agent Skills | `.agents/skills/**`, `$HOME/.agents/skills/**` | Cross-agent convention |
| SkillHub | (future) registry endpoint | Deferred |

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client (Agent)                   │
└─────────────┬───────────────────────────────────────────┘
              │ JSON-RPC over stdio
┌─────────────▼───────────────────────────────────────────┐
│                 MCP API Surface                         │
│  index_skills · list_skills · get_skill_manifest        │
│  get_skill_sections · load_skill_context · load_section │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Retrieval Layer                            │
│  RetrievalRequest → RetrievalBundle (progressive)       │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Compiler                                   │
│  ParsedMarkdown → SkillManifest + SkillSection[]        │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Parser + Classifier                        │
│  markdown → ParsedSection[] + ClassificationResult      │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Normalizer                                 │
│  DiscoveredArtifact → NormalizedSkillInput              │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Discovery (per-system adapters)            │
│  Claude · OpenCode · Codex · Cursor · Roo · Cline ·     │
│  Continue · GitHub · Agents · Windsurf · Copilot        │
└─────────────┬───────────────────────────────────────────┘
              │
┌─────────────▼───────────────────────────────────────────┐
│              Store (SkillIndex, JSON on disk)           │
│  manifest + sections + freshness metadata               │
└─────────────────────────────────────────────────────────┘
```

## 4. Proposed File Tree and Component Responsibilities

```
src/
  index.ts               # MCP server entrypoint, tool registration
  types.ts               # All TypeScript interfaces (section 5)
  config.ts              # Roots, allowlist, feature flags
  fs/
    watcher.ts           # File-watcher for freshness
    hash.ts              # rootHash helper
  discovery/
    adapter.ts           # DiscoveryAdapter interface
    claude.ts            # ~/.claude/skills, <plugin>/skills
    opencode.ts          # .opencode/skills, ~/.config/opencode/skills
    codex.ts             # /etc/codex/skills
    cursor.ts            # .cursor/rules/*.mdc, .cursorrules
    roo.ts               # .roo/skills*, .roo/rules*
    cline.ts             # .clinerules, ~/Documents/Cline/Rules
    continue.ts          # .continue/rules/*.md
    github.ts            # .github/skills, .github/instructions/**/*.instructions.md
    copilot.ts           # ~/.copilot/skills
    agents.ts            # .agents/skills, $HOME/.agents/skills
    windsurf.ts          # .windsurfrules
    index.ts             # Adapter registry + runner
  normalize/
    index.ts             # DiscoveredArtifact → NormalizedSkillInput
  parser/
    index.ts             # Markdown → ParsedMarkdown
    headings.ts          # Heading slug + hierarchy
    frontmatter.ts       # Optional YAML frontmatter
  compiler/
    classify.ts          # Section → SectionClass + policy
    references.ts        # Extract ReferenceRef from body
    manifest.ts          # Build SkillManifest
  store/
    index.ts             # SkillIndex read/write
    paths.ts             # Store location resolution
    freshness.ts         # mtime + content-hash checks
  search/
    filter.ts            # Deterministic filter (no embeddings)
    rank.ts              # Heuristic rank (class, position, name match)
  retrieval/
    bundle.ts            # Build RetrievalBundle
    omit.ts              # Build OmittedItem list
  mcp/
    tools.ts             # Tool handlers
    resources.ts         # Optional resource handlers
    server.ts            # Server lifecycle
tests/
  fixtures/              # Sample SKILL.md, .mdc, .instructions.md, etc.
  discovery.test.ts
  normalize.test.ts
  parser.test.ts
  compiler.test.ts
  store.test.ts
  retrieval.test.ts
  mcp.test.ts
```

## 5. TypeScript Interfaces

```typescript
export type SourceSystem =
  | "claude" | "opencode" | "codex" | "cursor" | "roo"
  | "cline" | "continue" | "github" | "copilot"
  | "agents" | "windsurf";

export type ArtifactKind = "skill_md" | "rule_md" | "mdc" | "instructions_md";

export type SectionClass = "always" | "phase" | "on_demand" | "reference";

export interface DiscoveryContext {
  workspaceRoot: string;
  homeDir: string;
  pluginRoots: string[];
  system: SourceSystem;
}

export interface DiscoveryAdapter {
  system: SourceSystem;
  scan(ctx: DiscoveryContext): Promise<DiscoveredArtifact[]>;
}

export interface DiscoveredArtifact {
  system: SourceSystem;
  kind: ArtifactKind;
  absolutePath: string;
  skillName: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface NormalizedSkillInput {
  id: string;                   // {rootHash}::{system}::{skill_name}
  source: DiscoveredArtifact;
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface ParsedMarkdown {
  title: string | null;
  sections: ParsedSection[];
  preamble: string;            // content before first heading
}

export interface ParsedSection {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  heading: string;
  slug: string;
  body: string;
  children: ParsedSection[];
}

export interface ClassificationResult {
  sectionId: string;            // {rootHash}::{system}::{skill_name}::{heading_slug}
  class: SectionClass;
  rationale: string;
  policy: MandatoryPolicy;
  references: ReferenceRef[];
}

export interface MandatoryPolicy {
  alwaysInclude: boolean;
  includeWhen?: string;         // short trigger phrase
  deferUntil?: string;          // phase name
}

export interface SkillManifest {
  id: string;
  system: SourceSystem;
  skillName: string;
  title: string | null;
  rootHash: string;
  sourcePath: string;
  mtimeMs: number;
  contentHash: string;
  sections: ManifestSectionRef[];
  loadedReferences: LoadedReference[];
}

export interface ManifestSectionRef {
  id: string;
  heading: string;
  slug: string;
  level: number;
  class: SectionClass;
  byteLength: number;
  references: ReferenceRef[];
}

export interface SkillSection {
  id: string;
  manifestId: string;
  class: SectionClass;
  heading: string;
  body: string;
  references: ReferenceRef[];
}

export interface ReferenceRef {
  target: string;               // relative path or URL
  kind: "file" | "url" | "skill";
  resolved?: string;            // absolute path if resolvable
}

export interface LoadedReference {
  ref: ReferenceRef;
  snippet: string;              // first ~200 chars
  available: boolean;
}

export interface SkillIndex {
  version: 1;
  generatedAt: string;          // ISO
  manifests: Record<string, SkillManifest>;      // id → manifest
  sections: Record<string, SkillSection>;        // id → section
  bySystem: Record<SourceSystem, string[]>;      // system → manifest ids
}

export interface RetrievalRequest {
  skillId?: string;
  sectionIds?: string[];
  includeClasses?: SectionClass[];
  followReferences?: boolean;
  maxBytes?: number;
  omitBodies?: boolean;
}

export interface RetrievalBundle {
  manifest: SkillManifest;
  sections: SkillSection[];
  references: LoadedReference[];
  omitted: OmittedItem[];
  totalBytes: number;
}

export interface OmittedItem {
  id: string;
  heading: string;
  class: SectionClass;
  reason: "budget" | "class_filter" | "not_requested";
  byteLength: number;
}
```

## 6. Discovery / Scanning Plan

Allowlist (resolved per workspace + home):

```
.claude/skills/**/SKILL.md
~/.claude/skills/**/SKILL.md
<plugin-root>/skills/**/SKILL.md
.opencode/skills/**/SKILL.md
~/.config/opencode/skills/**/SKILL.md
.agents/skills/**/*
$HOME/.agents/skills/**/*
/etc/codex/skills/**/*
.github/skills/**/*
.github/instructions/**/*.instructions.md
~/.copilot/skills/**/*
.cursor/rules/*.mdc
.cursorrules
.windsurfrules
AGENTS.md
.roo/skills*/**/*
.roo/rules*/**/*
.clinerules
.clinerules/**/*.md
.clinerules/**/*.txt
~/Documents/Cline/Rules/**/*
.continue/rules/*.md
```

Each adapter implements `DiscoveryAdapter.scan(ctx)`. Adapters are pure
functions of (workspace, home, pluginRoots); no global state. Symlinks
followed one level; cycles broken by visited-set on realpath.

## 7. Normalization Plan

`normalize(artifact, rawText)`:
1. Strip BOM, normalize line endings to `\n`.
2. Split optional YAML frontmatter (between `---` fences).
3. Compute `rootHash` = first 8 hex of sha256(workspaceRoot).
4. Build `id = {rootHash}::{system}::{skillName}`.
5. Return `NormalizedSkillInput`.

No content transformation beyond this — the parser sees the original
markdown.

## 8. Markdown Parsing / Classification

**Parser:** heading tree via single-pass regex on `^(#{1,6})\s+(.+)$`.
Builds `ParsedSection` tree with `slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")`.

**Classifier:** each `ParsedSection` → `ClassificationResult`.

**Section classes:**
- `always` — preamble, top-level metadata, hard constraints.
- `phase` — setup / implementation / verification phases.
- `on_demand` — examples, edge cases, troubleshooting.
- `reference` — links to other files/skills/URLs.

**Mandatory policy extraction regex (heuristic):**
```
/\b(MUST|SHOULD|MAY|REQUIRED|OPTIONAL|when\s+[\w\s]+|only\s+when|if\s+[\w\s]+)\b/i
```
Match in heading or first sentence → `alwaysInclude: true` with
`includeWhen` set to the trigger phrase.

**Reference extraction rules:**
- Markdown links `[text](path)` where path is relative → `kind: "file"`.
- URLs `https?://...` → `kind: "url"`.
- `skill:foo` or `@skill/foo` → `kind: "skill"`.
- Paths resolved against the skill file's directory; unresolved marked
  `available: false`.

## 9. Stable IDs, Store, Freshness

**Skill ID:** `{rootHash}::{system}::{skill_name}`
- `rootHash` = first 8 hex of sha256(workspaceRoot)
- `skill_name` = directory name containing SKILL.md, or filename stem

**Section ID:** `{rootHash}::{system}::{skill_name}::{heading_slug}`

**Store:** JSON file at
`~/.cache/skill-compiler-mcp/{rootHash}/index.json`.
Atomic write via `write-to-temp + rename`.

**Freshness:** on each retrieval call, compare stored
`mtimeMs` + `contentHash` against the source file. If stale,
re-parse + re-compile just that skill; patch the index. Background
re-index triggered by `index_skills` tool or file-watcher event.

## 10. Retrieval Flow

```
RetrievalRequest
   │
   ├─ resolve manifest (by skillId or filter)
   ├─ select sections by class / ids
   ├─ if followReferences: load and inline snippets
   ├─ apply maxBytes budget:
   │     always → phase → on_demand → reference
   │     overflow → move tail to omitted[]
   └─ return RetrievalBundle
```

Ordering is deterministic: always-first, then by source position.
No scoring, no embeddings.

## 11. MCP API

**Tools:**
- `index_skills` — (re)scan all adapters, write index.
- `list_skills` — return manifest summaries, filterable by system.
- `get_skill_manifest` — full manifest for one skill id.
- `get_skill_sections` — section metadata for one skill.
- `load_skill_context` — full `RetrievalBundle` for a request.
- `load_section` — single section by id.

**Optional resources (deferred):**
- `skill-compiler://skills` — list
- `skill-compiler://skill/{id}` — manifest

**Deferred diagnostic tools:**
- `discovery_health` — per-adapter counts + errors.
- `freshness_report` — stale entries.

## 12. Implementation Units

- **U1** — types.ts, config.ts, fs/hash.ts. Zero deps.
- **U2** — discovery adapters (one file per system) + runner.
- **U3** — normalize + parser + heading slug.
- **U4** — classifier + reference extractor + manifest builder.
- **U5** — store (read/write/freshness) + paths.
- **U6** — retrieval (bundle builder, budget, omit).
- **U7** — MCP tool handlers + server lifecycle.
- **U8** — fixtures + unit tests per unit.
- **U9** — integration test: end-to-end retrieval against a fixture
  workspace.

Each unit is independently shippable; U1–U5 have no MCP dependency.

## 13. Tests and Evaluation

| Metric | Target | Measurement |
|---|---|---|
| Discovery recall | 100% of fixtures found | fixture-based test per adapter |
| Parse correctness | 100% heading tree match | snapshot tests |
| Classification stability | identical input → identical output | deterministic ID test |
| Retrieval latency p95 | < 50ms for 500-skill index | benchmark script |
| Freshness detection | 100% of mtime changes | watcher test |
| Bundle size accuracy | within 5% of maxBytes | budget test |
| Zero embeddings | confirmed | grep test: no `embed`, `vector`, `cosine` |

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Path explosion on large workspaces | slow scan | per-adapter timeout + cache |
| Symlink cycles | infinite loop | visited-set on realpath |
| Frontmatter parse errors | lost metadata | tolerant parser, fallback to body |
| Stale index served | wrong context | freshness check on every retrieval |
| MCP protocol drift | broken tools | pin `@modelcontextprotocol/sdk` |
| Cross-platform path issues | missed files | `path.resolve` + realpath everywhere |
| Large skill files | budget overflow | deterministic omit with clear reason |

## 15. Open Decisions (Ponytail Defaults)

- **No embeddings.** Ever, unless retrieval recall drops below 80% on a
  measured benchmark. Then reconsider, don't bolt on.
- **No vector DB.** JSON on disk is the store. Upgrade only if index
  exceeds 10k skills AND retrieval latency breaks budget.
- **No graph traversal.** References are resolved one level; no transitive
  closure unless explicitly requested.
- **Single index file.** No sharding, no SQLite, until proven necessary.
- **No file watcher by default.** On-demand freshness check; watcher is
  opt-in via config.
- **No cross-session learning.** Index is rebuilt from disk, not from
  usage.
- **No semantic search.** Keyword filter on skill/section name only.

## Validation Commands (When Scaffolded)

```bash
# Build
npm run build

# Unit tests
npm test

# Integration test against fixtures
npm run test:integration

# Bench retrieval latency
npm run bench:retrieval

# Verify zero embeddings
! grep -rE "embed|vector|cosine|similarity" src/

# Run MCP server locally
npx tsx src/index.ts

# Smoke: list skills from a fixture workspace
npx tsx src/index.ts --workspace ./tests/fixtures/workspace list_skills
```

## Research Coverage / Deferred Details

**Covered:** discovery paths, normalization, parsing, classification,
IDs, store, retrieval, MCP API, implementation units, tests, risks.

**Deferred (YAGNI until measured):**
- Semantic search / embeddings.
- Graph-RAG / transitive reference closure.
- Resource handlers (MCP resources).
- Diagnostic tools (`discovery_health`, `freshness_report`).
- SkillHub registry integration.
- Cross-agent skill sharing protocol.
- Usage telemetry.
- Plugin-hosted skill manifests.

**Debt markers (`ponytail:` comments) to add in code:**
- `// ponytail: single-level reference resolution; transitive if users ask`
- `// ponytail: JSON store; SQLite if index > 10k skills`
- `// ponytail: on-demand freshness; file watcher if latency matters`
- `// ponytail: keyword filter only; embeddings if recall < 80%`
