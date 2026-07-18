# Ruleloom

> Policy-first context compiler for coding agents.

Ruleloom is an MCP server that turns a mess of `SKILL.md`, `AGENTS.md`, Copilot instructions, and similar rule files into a small, deterministic, queryable set of policy fragments. An agent asks for context, Ruleloom returns the minimum policy that actually applies, in the order it should apply, with conflicts surfaced explicitly.

The design is a compiler plus a BM25-lite fallback. It is not a RAG system. Ruleloom does not embed your rules into a vector database, and it does not silently drop conflicts. Every load is reproducible from the on-disk source.

## Why

Harnesses accumulate rule files. A single repo can carry Claude, OpenCode, Codex, and Copilot rules in the same checkout, plus global rules from `~/.claude/`, `~/.config/opencode/`, and friends. When an agent starts a task, the right question is rarely "give me all of it." The right question is: which rules apply right now, in what order, and where do they disagree.

Ruleloom answers that question.

## Quick start

### 1. Build the server

```sh
git clone <repo-url> ruleloom
cd ruleloom
npm install
npm run build
```

The build emits a stdio MCP server at `dist/index.js`. Run it directly to confirm it starts:

```sh
node dist/index.js
# the process should start silently and wait for JSON-RPC on stdin
```

### 2. Register it with your harness

The exact JSON shape depends on the host. See [docs/installation.md](docs/installation.md) for Claude Code, Claude Desktop, Codex, OpenCode, VS Code, and Cursor. A generic shape looks like this:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["/absolute/path/to/ruleloom/dist/index.js"]
    }
  }
}
```

### 3. Index your repo

From your agent or harness, call:

```json
{ "name": "index_skills", "arguments": { "system": "claude" } }
```

The first call writes the cache to `.skill-cache/` inside the working directory of the MCP server. Subsequent calls are cheap and validate freshness.

### 4. Ask for context

```json
{
  "name": "load_skill_context",
  "arguments": { "query": "how should I structure a new feature", "maxBytes": 4000 }
}
```

You get back a `context` string plus a `sections` array, with `omitted` entries for anything that did not fit the budget.

## Supported hosts

| Host | Status | Notes |
| --- | --- | --- |
| Claude Code (CLI) | Supported | stdio, register in `claude_desktop_config.json` or project `.mcp.json` |
| Claude Desktop | Supported | stdio |
| OpenCode | Supported | register in project or global `opencode.json` |
| Codex CLI | Supported | stdio via `codex mcp` |
| VS Code + Copilot | Supported | stdio, register in `.vscode/mcp.json` or user `mcp.json` |
| Gemini CLI | Supported | stdio MCP; dedicated `gemini` indexing adapter |
| Cursor | Supported | stdio MCP; dedicated `cursor` indexing adapter |
| Devin Desktop (formerly Windsurf) | Supported | stdio MCP; dedicated `windsurf` rules adapter for the current latest-release contract |
| Cline | Supported | stdio MCP; dedicated `cline` rules/config adapter for Cline 4.0.8 and CLI 3.0.40 |
| Roo Code | Supported | stdio MCP; dedicated `roo` indexing adapter for final v3.54.0 filesystem contracts |
| Continue | Supported | stdio MCP; dedicated `continue` workspace-rules/config adapter for v2.0.0-vscode |
| Aider | Supported | stdio MCP; dedicated `aider` adapter for v0.86.0 `.aider.conf.yml` `read` entries |
| Generic MCP client | Supported | anything that speaks MCP over stdio |

Ruleloom has no network dependencies. It reads from local files, writes a local cache, and never phones home.

Claude Code indexing covers documented project, nested, and user skills,
legacy commands, rules, and `CLAUDE.md` instruction files. It does not crawl
plugin caches or reconstruct runtime-effective plugin sources; use explicit
`index_skills.roots` for trusted sources outside the documented roots.

OpenCode indexing covers documented project/global `.opencode`, `.agents`, and
Claude-compatible skill roots plus `AGENTS.md`/`CLAUDE.md` fallback files. It
does not crawl OpenCode caches or `node_modules`, resolve configured instruction
globs, or claim runtime-effective plugin paths. When those paths are unavailable,
`discoveryDiagnostics` points to explicit `index_skills.roots` as the fallback.

Codex CLI indexing covers the documented `AGENTS.override.md`/`AGENTS.md`
hierarchy, repository and user `.agents/skills`, and repository/user custom
agents under `.codex/agents`. Unix admin skills under `/etc/codex/skills` remain
opt-in. Ruleloom does not resolve configured fallback names, alternate
`CODEX_HOME`, bundled/plugin/runtime-effective sources, or crawl caches; use
trusted explicit `index_skills.roots` when needed.

GitHub Copilot/VS Code indexing covers repository instructions, path-specific
instructions, root `AGENTS.md`/Claude-compatible instructions, documented
project/personal skills, prompts, and custom agents. It preserves `applyTo` and
Claude `paths` metadata but cannot apply those globs without a target file. VS
Code profile user data, configured extra locations, organization/extension
sources, nested experimental `AGENTS.md`, and runtime-applied diagnostics are
not crawled; use trusted explicit `index_skills.roots` for readable sources.

Gemini CLI indexing covers documented workspace/user `.gemini/skills` and
`.agents/skills`, the supplied `GEMINI.md` hierarchy, and direct installed
extension `skills/` roots under `~/.gemini/extensions`. It preserves Gemini's
workspace/user/extension and `.agents` alias precedence without crawling caches
or package trees. Built-ins, linked/disabled/runtime state, custom context file
names, imports, and JIT context are not reconstructed; use trusted explicit
`index_skills.roots` for readable sources outside the documented roots.

Cursor indexing covers recursive project `.cursor/rules/**/*.mdc`, root
`AGENTS.md`/`CLAUDE.md`, legacy `.cursorrules`, and documented project/user
`.cursor`, `.agents`, Claude-compatible, and Codex-compatible skill roots. It
preserves rule and skill frontmatter during normalization but does not evaluate
path applicability or reconstruct final rule ordering/effective prompts. User
and team rules, commands, plugins, settings state, and runtime context have no
stable readable contract in current official docs; use trusted explicit
`index_skills.roots` for readable sources outside the confirmed roots.

Windsurf indexing targets current Devin Desktop: preferred workspace
`.devin/rules`, documented fallback `.windsurf/rules` and `.windsurfrules`, the
workspace `AGENTS.md` hierarchy, and the still-current global rule at
`~/.codeium/windsurf/memories/global_rules.md`. It does not crawl other memories,
private/cache state, enterprise system rules, activation state, or final prompts;
use trusted explicit `index_skills.roots` for readable unsupported sources.

Cline indexing covers workspace `.clinerules` files/directories, current
`.cline/rules`, documented compatibility instructions, and current/legacy skill
roots. With global discovery enabled it also reads documented `~/.cline` and
`~/Documents/Cline` rule/skill locations plus `~/.agents/AGENTS.md`. It does not
read settings, secrets, rule toggles, remote rules, active Plan/Act state,
custom data directories, private extension storage, or runtime-effective
prompts; pass trusted alternate roots through `index_skills.roots`.

Roo Code indexing covers global/workspace `.roo/rules`, all discovered
`.roo/rules-{mode}` directories, documented `.roo`/`.agents` generic and
mode-specific skill roots, `.roorules` fallbacks, and root `AGENTS.md` or
`AGENT.md`. It reads only the stable `roo-cline.useAgentRules` boolean from
standard VS Code user/workspace settings; it does not infer the active mode,
read private extension state, or reconstruct UI instructions or final prompts.
Use trusted explicit `index_skills.roots` for other readable sources.

Continue indexing covers workspace `.continue/rules/*.md` files (including
their YAML frontmatter) and local Markdown rule/prompt files referenced with
canonical `file://` URLs by the active `~/.continue/config.yaml` (or deprecated
`config.json` fallback). Inline and remote config entries, user rules without a
documented readable path, Hub blocks, toolbar selection, and composed/final
system messages are not reconstructed. Use trusted explicit
`index_skills.roots` for other readable local sources.

Aider has no native skills directory. Aider indexing reads only bounded regular
files explicitly listed by `read:` in supported `.aider.conf.yml` files from the
supplied home, repository, and workspace/current-directory locations, preserving
that documented precedence. It does not infer `CONVENTIONS.md` or other filenames,
inspect session `/read` state or unavailable CLI arguments, follow directories or
symlinks, select alternate `--config` files, or reconstruct runtime/final prompts.
Use trusted explicit `index_skills.roots` for readable sources unavailable through
the supported config locations.

## MCP tools

## CLI

`ruleloom index`, `search`, `resolve`, `get`, `doctor`, `watch`, and `stats` are
available after `npm run build`. `get skill#section` loads one section;
`get skill` returns that skill's section list. Use `--json` for deterministic
JSON output. `doctor` is read-only and exits 0 for clean, 1 for warnings, and 2
for errors; MCP returns the same diagnostic report without an exit code.
`stats` reports persisted active-session and lifetime Ruleloom estimated token
proxies. Use `--session-id ID` for an opaque caller-chosen session or
`--new-session` to start one.

Ruleloom exposes MCP tools. Names are stable. Schemas are JSON Schema over the MCP `tools/call` method. Argument validation is strict and returns `{ errors: [...] }` for bad input rather than throwing.

| Tool | Purpose |
| --- | --- |
| `index_skills` | Discover, normalize, and compile rule files for one system into the local cache. |
| `discover_skill_folders` | Opt-in, bounded discovery of known roots and folders literally named `skills`. |
| `list_skills` | Enumerate every indexed skill, with token counts and conflict counts. |
| `get_skill_manifest` | Read the compiled manifest for one skill by ID. |
| `get_skill_sections` | Read the section list (with class, policy, references) for one skill. |
| `load_skill_context` | Retrieve minimal, policy-first context for a query, with budget controls. |
| `load_section` | Load exactly one section by ID, plus its links and duplicate references. |
| `doctor` | Read-only diagnostics for the indexed corpus. |
| `get_token_savings_stats` | Return active-session and lifetime estimated token proxy totals. |

`discover_skill_folders` never runs automatically, reads no skill content, and never indexes or compiles. An explicit call recursively checks only the project root by default, or the home directory only with `{ "scope": "home" }`. It finds supported canonical roots plus directories whose basename is exactly lowercase `skills` (case-sensitive), then reports exact `SKILL.md` or `skill.md` packages beneath them. It does not inspect arbitrary files, accept a custom discovery root, scan `/`, or crawl the full machine. Traversal skips common generated/private directories and symlinks and is bounded by depth, result, and scan-entry caps.

Candidate `system` values use the canonical `SOURCE_SYSTEMS` list. A supported system may have no indexable candidate root: Aider, for example, reports only a non-indexable `.aider.conf.yml` candidate and is indexed through its configured `read:` files or explicit roots.
Use `indexRoot` and `system` only when `indexable` is true. Known roots retain their harness system; unknown `skills` folders use `generic`. `indexRoot` is an absolute directory, including for `scope: "home"`; do not pass `candidate.path`, which is display-only and may name a file. Generic indexing is always explicit:

```json
{ "name": "discover_skill_folders", "arguments": {} }
{ "name": "discover_skill_folders", "arguments": { "scope": "home" } }
{ "name": "index_skills", "arguments": { "system": "generic", "roots": ["/absolute/indexRoot/from/candidate"] } }
```

Full schemas, input examples, and response shapes live in [docs/tool-reference.md](docs/tool-reference.md). If you are wiring Ruleloom into an agent, start with [docs/agent-guide.md](docs/agent-guide.md).

## What the cache looks like

The MCP server writes to `<cwd>/.skill-cache/` by default. You can override that with `McpServerOptions.storeDir` if you embed Ruleloom programmatically. The layout:

```
.skill-cache/
  index.json          # sectionId -> content hash
  manifests.json      # skillId -> SkillManifest
  sections/           # one JSON file per section, base64url(id).json
  savings.json         # v3 local totals, opaque per-session aggregates, and last 100 records
```

`index.json` and `manifests.json` are written atomically (temp + rename). Treat the directory as Ruleloom's. Don't edit it by hand.

Token savings are local, persisted Ruleloom estimates: whole-skill token estimate
minus the sections loaded. They are not provider usage, billing, or cost data.
The cache stores no query/task text, returned content, host user ID, or other
user identifier; only opaque session IDs, their aggregate token totals, and up to
100 metric records are kept.

## Verification

After installing, run a smoke test from your agent:

```json
{ "name": "list_skills", "arguments": {} }
```

A fresh install returns `{ "skills": [], "count": 0 }`. After an `index_skills` call, the same tool returns one entry per indexed skill.

You can also run the unit tests:

```sh
npm test
npm run typecheck
```

## Documentation

- [docs/installation.md](docs/installation.md): host-specific MCP config, including the Windows `cmd /c npx` pattern.
- [docs/tool-reference.md](docs/tool-reference.md): exact tool names, schemas, and example payloads.
- [docs/agent-guide.md](docs/agent-guide.md): what an agent should do on first contact, how to handle `rebuildRequired`, and how to read conflict diagnostics.
- [docs/troubleshooting.md](docs/troubleshooting.md): fixes for the usual failures: not discovered, stale index, permissions, token budget, wrong rule loaded.
- [docs/examples.md](docs/examples.md): realistic workflows end to end.
- [llms.txt](llms.txt): a short machine-readable index of the docs and tool surface.

## Inspiration and acknowledgements

Ruleloom's compiler-first shape and conflict-aware diagnostics borrow from a few projects that already think hard about agent context:

- [GitNexus](https://github.com/abhigyanpatwari/GitNexus): code knowledge graph, query-first exploration, and process traces over the call graph.
- [Superpowers](https://github.com/obra/superpowers): a skills-as-software mindset, with explicit precedence and reusable procedures.
- [MCP servers](https://github.com/modelcontextprotocol/servers): the reference set of MCP servers, which fixes the transport and capability contract that Ruleloom speaks.

## Status

The MCP server, compile pipeline, retrieval layer, and on-disk store are implemented and tested. The package is not on the npm registry yet. To use it, build from source and point your harness at `dist/index.js`. Once a release is cut, install commands will use `<package-name>` as a placeholder until the published name is finalized.

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json
npm start           # node dist/index.js (starts the stdio MCP server)
```

## License

See repository. Ruleloom is intended to be Apache-2.0 or MIT. Confirm before shipping.
