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
| OpenCode | Supported | register in `opencode.json` or `.opencode/config.json` |
| Codex CLI | Supported | stdio via `codex mcp` |
| VS Code + Copilot | Supported | stdio, register in `.vscode/mcp.json` or user `mcp.json` |
| Cursor | Supported | generic stdio MCP |
| Generic MCP client | Supported | anything that speaks MCP over stdio |

Ruleloom has no network dependencies. It reads from local files, writes a local cache, and never phones home.

## MCP tools

Ruleloom exposes six tools. Names are stable. Schemas are JSON Schema over the MCP `tools/call` method. Argument validation is strict and returns `{ errors: [...] }` for bad input rather than throwing.

| Tool | Purpose |
| --- | --- |
| `index_skills` | Discover, normalize, and compile rule files for one system into the local cache. |
| `list_skills` | Enumerate every indexed skill, with token counts and conflict counts. |
| `get_skill_manifest` | Read the compiled manifest for one skill by ID. |
| `get_skill_sections` | Read the section list (with class, policy, references) for one skill. |
| `load_skill_context` | Retrieve minimal, policy-first context for a query, with budget controls. |
| `load_section` | Load exactly one section by ID, plus its links and duplicate references. |

Full schemas, input examples, and response shapes live in [docs/tool-reference.md](docs/tool-reference.md). If you are wiring Ruleloom into an agent, start with [docs/agent-guide.md](docs/agent-guide.md).

## What the cache looks like

The MCP server writes to `<cwd>/.skill-cache/` by default. You can override that with `McpServerOptions.storeDir` if you embed Ruleloom programmatically. The layout:

```
.skill-cache/
  index.json          # sectionId -> content hash
  manifests.json      # skillId -> SkillManifest
  sections/           # one JSON file per section, base64url(id).json
```

`index.json` and `manifests.json` are written atomically (temp + rename). Treat the directory as Ruleloom's. Don't edit it by hand.

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
