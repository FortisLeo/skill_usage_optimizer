# Troubleshooting

The usual failures, organized by what you see. Each section names the symptom, the cause, and the fix. Nothing here is exotic. Almost every Ruleloom problem is one of: not built, wrong path, stale cache, wrong system, or out of budget.

## "Not discovered" by my harness

**Symptom.** The MCP tools list does not include `index_skills`, `list_skills`, and friends. The harness either ignores the config or reports a spawn failure.

**Causes and fixes.**

1. **Built output is missing.** Run `npm run build` in the repo root. The file `dist/index.js` must exist.
2. **Path in MCP config is wrong.** Open the config and confirm the absolute path resolves. On macOS and Linux, prefer forward slashes. On Windows, see the `cmd /c npx` pattern in [installation.md](installation.md).
3. **The harness hasn't reloaded the config.** Most harnesses read the config at startup. Restart the harness, or use its MCP reload command if it has one.
4. **JSON is malformed.** Validate with `python3 -m json.tool` or your editor. A trailing comma or a smart quote will silently kill the file.
5. **The host expects a different shape.** Claude Code, Codex, OpenCode, and Cursor all use the standard `mcpServers` shape, but the key name sometimes varies. See [installation.md](installation.md) for the exact JSON per host.

A quick way to confirm Ruleloom itself is fine: run `node /absolute/path/to/ruleloom/dist/index.js` from your shell. The process should hang silently (it's waiting for JSON-RPC on stdin). If it crashes immediately, the build is broken.

## Stale index

**Symptom.** A read tool returns:

```json
{
  "freshness": "stale",
  "rebuildRequired": { "code": "REBUILD_REQUIRED", "action": "index_skills", "sectionIds": ["X"], "manifestIds": ["Y"], "reason": "source_changed" }
}
```

**Cause.** A rule file on disk was edited, added, or removed after the last `index_skills` call. Ruleloom returns bounded rebuild metadata without rereading or returning changed source content.

**Fix.** Call `index_skills` for the affected system. If you need to bypass reuse and rewrite that system's records, pass `force: true`. Force preserves other systems and savings and produces the same final requested-system slice as a normal successful reindex:

```json
{ "name": "index_skills", "arguments": { "system": "claude", "force": true } }
```

After the rebuild, retry the read. The `rebuildRequired` envelope goes away.

## Empty index

**Symptom.** `list_skills` returns `{ "skills": [], "count": 0 }` even though rule files exist on disk.

**Causes and fixes.**

1. **Wrong system.** Rule files for Claude go under `.claude/`. Rule files for OpenCode go under `.opencode/`. Rule files for Copilot go under `.github/copilot/` or `.github/instructions/`. Cursor rules go under `.cursor/rules/`. Gemini CLI skills go under `.gemini/skills/` or `.agents/skills/`. Current Devin Desktop rules go under `.devin/rules/`, with legacy Windsurf fallbacks under `.windsurf/rules/` or `.windsurfrules`. Cline rules go under `.clinerules` or `.cline/rules/`. Roo Code rules go under `.roo/rules/` or `.roo/rules-{mode}/`. Continue workspace rules go under `.continue/rules/`. Aider has no native skills directory and requires supported `.aider.conf.yml` `read:` entries or explicit roots. If you indexed `claude` and your rules are under `.opencode/`, you indexed the wrong system. Re-index with the matching system.
2. **Wrong working directory.** Ruleloom uses the MCP process's `cwd` as the workspace root. If the harness launched Ruleloom from a directory that isn't the project root, the discovery scan sees no rule files. Pass `baseDir` explicitly:

   ```json
   { "name": "index_skills", "arguments": { "system": "claude", "baseDir": "/Users/me/code/myproject" } }
   ```
3. **Globals only.** If you expected global rules (under `~/.claude/`, `~/.config/opencode/`) to show up, remember that global discovery is controlled by the server/indexing configuration. If you only see global rules and not workspace rules, the workspace discovery failed. Check the `baseDir`.
4. **Rule file naming.** Ruleloom recognizes `SKILL.md`, `skill.md`, `instructions.md`, `rules.md`. If your rule file has a different name, it is not picked up. Either rename the file, or pass its containing directory in `roots`. Explicit roots are directory-only:

   ```json
   { "name": "index_skills", "arguments": { "system": "claude", "roots": ["/abs/path/to"] } }
   ```

### Claude Code plugin or added-directory sources are missing

The Claude adapter indexes documented project, nested, and user skills, legacy
commands, rules, and `CLAUDE.md` instruction files. It intentionally does not
crawl `~/.claude/plugins`, caches, dependencies, managed policy, `--add-dir`
sources, or runtime state. A `SOURCE_UNSUPPORTED` configuration diagnostic is
expected. Pass a trusted local source directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "claude", "roots": ["/absolute/trusted/source-root"] } }
```

### OpenCode runtime or configured paths are missing

The shipped OpenCode adapter is documented-roots only. It indexes project and
global `.opencode`, `.agents`, and Claude-compatible skill roots plus the
documented `AGENTS.md`/`CLAUDE.md` fallbacks. It does not inspect OpenCode's
package cache, `node_modules`, plugin-merged `config.skills.paths`, or configured
instruction globs/URLs. A `SOURCE_UNSUPPORTED` discovery diagnostic is expected;
pass each trusted local directory explicitly instead:

```json
{ "name": "index_skills", "arguments": { "system": "opencode", "roots": ["/absolute/trusted/skill-root"] } }
```

Runtime-effective coverage needs the separately verified bridge writer and
reader and is not provided by this adapter.

### Codex configured, plugin, or bundled sources are missing

The Codex adapter indexes the documented AGENTS hierarchy, `.agents/skills`,
and `.codex/agents` from supplied project/user paths. `/etc/codex/skills` is
available only when system discovery is explicitly enabled. Configured fallback
instruction names, alternate `CODEX_HOME`, bundled skills, plugin-installed
sources, and runtime-effective state have no supported discovery handoff here;
a non-fatal `SOURCE_UNSUPPORTED` diagnostic is expected. Pass each trusted
local directory explicitly instead:

```json
{ "name": "index_skills", "arguments": { "system": "codex", "roots": ["/absolute/trusted/source-root"] } }
```

### Copilot/VS Code profile, organization, or runtime sources are missing

The Copilot adapter indexes confirmed repository and personal filesystem roots.
VS Code profile user data, configured `chat.*FilesLocations`, Settings Sync,
organization/extension sources, experimental nested `AGENTS.md`, and the UI-only
Chat Diagnostics/Agent Debug Logs have no stable portable reader here. A
`SOURCE_UNSUPPORTED` configuration diagnostic is expected. Ruleloom preserves
`applyTo`/`paths` frontmatter but cannot decide those scopes without a target
file. Pass each trusted readable directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "copilot", "roots": ["/absolute/trusted/source-root"] } }
```

### Cursor user/team rules, commands, or runtime sources are missing

The Cursor adapter indexes project `.cursor/rules/**/*.mdc`, root
`AGENTS.md`/`CLAUDE.md`, legacy `.cursorrules`, and the documented project/user
skill roots. Cursor user rules are settings-managed, and current official docs
do not expose a stable portable readable path for user/team rules or commands.
Ruleloom therefore does not scan `.cursor/commands`, private editor storage,
plugins, settings, enabled state, or runtime-effective context. A non-fatal
`SOURCE_UNSUPPORTED` configuration diagnostic is expected. Path metadata is
preserved during normalization but cannot be applied without a target file.
Pass each trusted readable directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "cursor", "roots": ["/absolute/trusted/source-root"] } }
```

### Gemini CLI linked, disabled, custom-context, or runtime sources are missing

The Gemini adapter indexes `.gemini/skills`, `.agents/skills`, the supplied
`GEMINI.md` hierarchy, and regular installed-extension `skills/` roots directly
under `~/.gemini/extensions`. It does not invoke `/skills list` or `gemini skills
list`, inspect runtime metadata, follow linked extension symlinks, apply enabled
or disabled state, resolve custom `context.fileName`, expand imports, or recreate
just-in-time context. A `SOURCE_UNSUPPORTED` configuration diagnostic is
expected. Pass each trusted real directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "gemini", "roots": ["/absolute/trusted/source-root"] } }
```

The official Gemini CLI documentation currently announces an unpaid-tier and
Google One migration to Antigravity CLI. The `gemini` adapter does not claim
Antigravity compatibility.

### Devin Desktop / Windsurf memories, system rules, or runtime context are missing

The `windsurf` adapter uses the current Devin Desktop contract: `.devin/rules`
first, documented `.windsurf/rules` and `.windsurfrules` compatibility, the
workspace `AGENTS.md` hierarchy, and only the current documented global rule
file at `~/.codeium/windsurf/memories/global_rules.md`. Other memory files are
auto-generated private workspace state and are intentionally not crawled.
Enterprise system rules, application `globalStorage`, caches, activation state,
and final prompts are also excluded and produce a bounded `SOURCE_UNSUPPORTED`
diagnostic. Pass a trusted readable fallback directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "windsurf", "roots": ["/absolute/trusted/rule-root"] } }
```

### Cline mode, toggle, custom-data, or runtime sources are missing

The `cline` adapter indexes the documented workspace `.clinerules` file or
directory, `.cline/rules`, compatibility instruction files, and current/legacy
skill roots. Global discovery includes the documented `~/.cline/rules`,
`~/.cline/skills`, `~/Documents/Cline/Rules`, and `~/.agents/AGENTS.md` paths.

Current Cline docs describe Plan and Act behavior, but not separate readable
mode-specific instruction roots. Rule toggles, remote rules, private
extension/settings state, `CLINE_DATA_DIR`, CLI `--data-dir`/`--config`
overrides, and runtime-effective prompts are therefore not inferred. Settings
files may contain credentials and are never indexed. A non-fatal
`SOURCE_UNSUPPORTED` diagnostic is expected. Pass a trusted custom rules or
skills directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "cline", "roots": ["/absolute/trusted/source-root"] } }
```

### Roo Code mode, UI, profile, or runtime sources are missing

The `roo` adapter targets Roo Code's final official v3.54.0 filesystem
contract. It indexes global/workspace generic and mode-specific rules and
skills, root `AGENTS.md`/`AGENT.md`, and `.roorules` fallbacks. Because an
index request has no verified active-mode input, every present mode-specific
root is retained explicitly rather than guessed or filtered.

Only `roo-cline.useAgentRules` is read from the standard VS Code user and
workspace `settings.json` locations. Active profiles, multi-root workspace
files, remote/policy settings, UI custom instructions, `.roomodes`
`customInstructions`, private extension storage, task state, and final prompts
are not reconstructed. A `SOURCE_UNSUPPORTED` diagnostic is expected. Pass a
trusted real directory explicitly when a readable source is outside the
confirmed roots:

```json
{ "name": "index_skills", "arguments": { "system": "roo", "roots": ["/absolute/trusted/source-root"] } }
```

### Continue user rules, config entries, or runtime state are missing

The `continue` adapter indexes workspace `.continue/rules/**/*.md` and local
Markdown files referenced by canonical `file://` URLs in the active
`~/.continue/config.yaml` (`schema: v1`), with deprecated `config.json` used
only when YAML is absent. It never indexes the whole config, so model keys and
unrelated settings stay out of Ruleloom. Inline rules/prompts, remote Hub
blocks, non-Markdown entries, deprecated programmable/workspace configs,
private state, current toolbar selection, and composed system messages are not
reconstructed. Malformed config is skipped non-fatally with `SOURCE_INVALID`;
unsupported runtime composition emits `SOURCE_UNSUPPORTED`.

Move a reusable rule or prompt into a trusted Markdown file and reference it
from Continue with a local `file://` URL, or pass its containing directory:

```json
{ "name": "index_skills", "arguments": { "system": "continue", "roots": ["/absolute/trusted/source-root"] } }
```

### Aider conventions, config references, or session files are missing

The `aider` adapter supports `read:` string/list entries from `.aider.conf.yml`
at the supplied home, repository, and workspace/current-directory locations.
Aider has no native skills directory, so Ruleloom does not guess
`CONVENTIONS.md` or other filenames. Relative references resolve from the
supplied Ruleloom workspace/base directory; use the same directory used to
launch Aider.

Session `/read` state, CLI/environment `--read`, alternate `--config` files,
configured directories, command files, histories, caches, and final prompts are
not observable. Missing, malformed, unsafe, symlinked, oversized, or over-limit
references are skipped non-fatally with bounded diagnostics. Put durable
instructions in a regular file listed by `read:`, or pass its trusted containing
directory explicitly:

```json
{ "name": "index_skills", "arguments": { "system": "aider", "roots": ["/absolute/trusted/source-root"] } }
```

## Windows: `npx` not found

**Symptom.** On Windows, the MCP server fails to start with "npx is not recognized" or "node is not recognized".

**Fix.** Use the `cmd /c` form in your MCP config:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "cmd",
      "args": ["/c", "node", "C:\\path\\to\\ruleloom\\dist\\index.js"]
    }
  }
}
```

Or, if your harness accepts an array `args` and finds `node` on `PATH`, the direct form works:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["C:\\path\\to\\ruleloom\\dist\\index.js"]
    }
  }
}
```

If the path has spaces, double-quote it inside the `args` array. JSON handles the escaping for you.

## Permissions and allowed roots

**Symptom.** `index_skills` returns errors that mention "outside allowed root" or "EACCES".

**Cause.** Ruleloom refuses to read rule files outside a small set of allowed roots: the workspace, the home directory globals, and any explicit `roots` you pass. The point is to keep Ruleloom from reading arbitrary files. If you pass `roots: ["/etc/passwd"]`, that is not in any allowed scope and the read is rejected.

**Fix.** Pass paths that are inside the workspace or inside the home directory globals. Don't pass system paths unless you mean to. If you really need a system path, run Ruleloom with appropriate OS permissions and add the path via `roots`.

## Token budget too low

**Symptom.** `load_skill_context` returns a small `content` string, and `omitted[]` is full of entries with `"reason": "budget"`.

**Cause.** You set `maxBytes` too low, or the query is broad and the matching sections are large.

**Fixes.**

1. Raise `maxBytes`. Try doubling it.
2. Narrow the query. Use a specific phrase instead of a generic one.
3. Pass a `phase` to filter to a slice. "How should I write tests" with `phase: "implementation"` returns a tighter bundle than the same query without a phase.
4. Split the question into multiple `load_skill_context` calls, one per phase or topic.

## Wrong rule loaded

**Symptom.** The user says "the policy you applied is not the one I wrote." The loaded section references a different file than expected.

**Causes and fixes.**

1. **Multiple systems, multiple sources.** The repo has the same skill name in more than one source. Ruleloom groups conflicts by `system::skillName`, then chooses by precedence, `sourcePath`, and `sourceHash`. Run `index_skills` and look at the `diagnostics` array. The `winner` is the one applied. The `shadowed` is the one the user expected.
2. **Global rule overrides workspace.** If a global rule under `~/.claude/skills/test-rules/SKILL.md` exists and the user just added a workspace rule under `.claude/skills/test-rules/SKILL.md`, the workspace wins. If the user thinks the global is the one being applied, check `precedence` in the manifest. Workspace precedence is 100, global is 40.
3. **System rule confusion.** Codex system rules under `/etc/codex/skills/` are indexed only when the server is configured to include system locations. They have the lowest precedence. If a system rule is winning, you are probably reading the wrong manifest. Check `precedence` in `get_skill_manifest`.
4. **Cache from a different repo.** Ruleloom writes to `<cwd>/.skill-cache/`. If the harness runs the server from a different directory than the one you think, the cache might belong to a different project. Delete `.skill-cache/` and re-index from the correct `baseDir`.

## "No skills indexed"

**Symptom.** `load_skill_context` returns `{ "errors": ["no skills indexed"] }`.

**Cause.** The cache is empty. This is the right answer, not a bug.

**Fix.** Call `index_skills` first. See the bootstrap sequence in [agent-guide.md](agent-guide.md).

## Conflict diagnostics overwhelming

**Symptom.** `index_skills` returns a `diagnostics` array with dozens of entries. The user is overwhelmed.

**Fix.** Don't surface all of them. Group by `conflictKey` and pick the top 3-5. The `winnerPrecedence` and `reason` fields give you a clean explanation. For most users, the right move is: "Rule X from system A and rule Y from system B both define 'test-rules'. Ruleloom used A because it has higher precedence. To switch, move A out of the workspace or delete it."

If the user wants the full list, render the `diagnostics` array verbatim. Don't paraphrase the file paths.

## Build failures

**Symptom.** `npm run build` fails with TypeScript errors.

**Fixes.**

1. Make sure you have a recent Node (20+).
2. Run `npm install` again. A partial install will produce a build that types don't resolve.
3. Check the tsconfig files. `tsconfig.json` is the editor config. `tsconfig.build.json` is the build config. The build emits to `dist/`. Don't edit either by hand.

## Server crashes silently

**Symptom.** The MCP server starts, the harness connects, and then the server disappears. No log, no error.

**Fixes.**

1. Run `node /absolute/path/to/ruleloom/dist/index.js` in a shell. If it crashes, you'll see a stack trace on stderr. Logs are stderr only. Ruleloom never writes to stdout because that would break the MCP transport.
2. Check the host's MCP server logs. Claude Desktop, OpenCode, and Cursor all have a place where they show the stderr output of MCP servers.
3. If the server runs but exits after the first request, the harness is closing stdin. Ruleloom does not have a "shutdown" handler. The host is expected to send SIGTERM when done.

## `unknown tool` error

**Symptom.** A tool call returns `{ "errors": ["unknown tool: X"] }`.

**Cause.** You called a tool name that is not in the six above. Common mistakes: `index_skills` vs `indexSkills`, `get_skill_manifest` vs `getSkillManifest`. Ruleloom uses snake_case. MCP tool names are exact-match.

**Fix.** Use the names from the [tool reference](tool-reference.md). The harness may auto-suggest names, but always cross-check against the table.

## Still stuck

Read the [agent guide](agent-guide.md) for the steady-state workflow, the [examples](examples.md) for typical flows, and the source under `src/` if you need to see what the tool actually does. Ruleloom is small enough to read end to end in one sitting.
