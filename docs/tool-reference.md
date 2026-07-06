# Tool Reference

Ruleloom exposes six MCP tools. Every tool takes a JSON object, returns a JSON string in the `content` array, and reports errors in the same shape:

```json
{ "errors": ["system must be one of: claude, opencode, codex, copilot"] }
```

A successful call returns the documented payload. A failure returns `{ "errors": [...] }` and the MCP response sets `isError: true`.

The `system` argument, when accepted, is one of: `claude`, `opencode`, `codex`, `copilot`. These match the rule-file conventions each harness ships with.

---

## `index_skills`

Discover, normalize, and compile rule files for one source system into the local cache. This is the only tool that writes. Call it once per system, or once per session if rule files change.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `system` | `'claude' \| 'opencode' \| 'codex' \| 'copilot'` | yes | Which system to index. |
| `roots` | `string[]` | no | Extra absolute paths to treat as rule roots for this system. Default: none. |
| `baseDir` | `string` | no | Workspace root for discovery. Default: server's `cwd`. |
| `force` | `boolean` | no | Wipe the cache for this system before indexing. Default: false. |

### Example input

```json
{
  "name": "index_skills",
  "arguments": {
    "system": "claude",
    "baseDir": "/Users/me/code/myproject",
    "force": false
  }
}
```

### Example output (success)

Conflict keys are `"<system>::<skillName>"`. Manifest IDs are `"<system>::<skillName>::<hash8>"` where `<hash8>` is the first 8 chars of the source's content hash. Section IDs append `"::<heading-slug>"` to the manifest ID.

```json
{
  "indexedSkills": 7,
  "indexedSections": 23,
  "errors": [],
  "conflictCount": 1,
  "diagnostics": [
    {
      "conflictKey": "claude::test-rules",
      "winner": {
        "system": "claude",
        "sourcePath": "/Users/me/code/myproject/.claude/skills/test-rules/SKILL.md",
        "sourceHash": "sha256:..."
      },
      "shadowed": [
        {
          "system": "opencode",
          "sourcePath": "/Users/me/code/myproject/.opencode/rules/test-rules.md",
          "sourceHash": "sha256:..."
        }
      ],
      "reason": "same_precedence_tiebreak",
      "winnerPrecedence": 80
    }
  ]
}
```

When two sources for the same `<system>::<skillName>` live at the same precedence (e.g. both at `workspace_root`), the winner is picked by deterministic source-path order, then source-hash order. Pass `force: true` and re-snapshot a source if you need to flip a tie-break without moving files.

### Notes

- `indexedSkills` is the number of distinct manifests. `indexedSections` is the count of compiled section records.
- `errors` is empty on success. Non-empty means discovery, normalization, or compilation hit a hard failure (unreadable file, parse error, unsafe path). Conflicts do not appear here. They live in `diagnostics`.
- `diagnostics` lists precedence conflicts. The winner is the source actually applied. The shadowed entries are still on disk but were suppressed.

---

## `list_skills`

Enumerate every indexed skill, with summary metadata and conflict counts. No arguments required, though you can filter by system.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `system` | `'claude' \| 'opencode' \| 'codex' \| 'copilot'` | no | Restrict the list to one system. |

### Example input

```json
{ "name": "list_skills", "arguments": { "system": "claude" } }
```

### Example output

```json
{
  "skills": [
    {
      "id": "claude::test-rules::abcd1234",
      "skillName": "test-rules",
      "system": "claude",
      "sectionCount": 4,
      "tokenCount": 812,
      "byteLength": 3478,
      "kind": "skill_package",
      "description": "Conventions for writing tests in this repo.",
      "precedence": 100,
      "conflictCount": 0
    }
    /* ... */
  ],
  "count": 7
}
```

### Stale index response

If any indexed section's source file has changed on disk since the last `index_skills`, the response is:

```json
{
  "errors": ["section \"claude::test-rules::abcd1234::setup\" source changed; rerun index_skills"],
  "rebuildRequired": {
    "code": "REBUILD_REQUIRED",
    "action": "index_skills",
    "sectionIds": ["claude::test-rules::abcd1234::setup"],
    "manifestIds": ["claude::test-rules::abcd1234"],
    "reason": "source_changed"
  }
}
```

If you see this, call `index_skills` (with `force: true` if the change is structural) and retry.

---

## `get_skill_manifest`

Read the compiled manifest for one skill. The manifest is the canonical summary: sections, references, precedence, conflicts, token counts.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `skillId` | `string` | yes | The skill ID. Get these from `list_skills`. |

### Example input

```json
{ "name": "get_skill_manifest", "arguments": { "skillId": "claude::test-rules::abcd1234" } }
```

### Example output

```json
{
  "skillId": "claude::test-rules::abcd1234",
  "hash": "sha256:...",
  "exists": true,
  "id": "claude::test-rules::abcd1234",
  "skillName": "test-rules",
  "system": "claude",
  "kind": "skill_package",
  "description": "Conventions for writing tests in this repo.",
  "sourcePath": "/Users/me/code/myproject/.claude/skills/test-rules/SKILL.md",
  "sourceHash": "sha256:...",
  "tokenCount": 812,
  "byteLength": 3478,
  "precedence": 100,
  "conflicts": [],
  "sections": [
    {
      "id": "claude::test-rules::abcd1234::setup",
      "title": "Setup",
      "class": "always",
      "tokenCount": 95,
      "byteLength": 412,
      "references": [
        { "target": "./helpers.ts", "kind": "file", "resolved": true, "absolutePath": "/Users/me/code/myproject/.claude/skills/test-rules/helpers.ts" }
      ],
      "policy": { "lines": ["Always run `npm test` before declaring a section done."], "alwaysInclude": true },
      "order": 0
    }
  ]
}
```

### Section classes

Each section is classified as one of:

- `always`: includes on every load.
- `phase`: includes when the agent signals the matching phase.
- `on_demand`: includes only when the query or follow-up explicitly asks for it.
- `reference`: includes only when `includeReferences: true` and the section is reachable from a `file` or `url` reference.

`policy.alwaysInclude: true` is a hard rule, not a hint. Ruleloom emits these sections even if the budget would otherwise drop them. Treat them as non-negotiable.

### Not found

```json
{ "errors": ["skill \"claude::ghost::abcd1234\" not found in index"] }
```

---

## `get_skill_sections`

Read the section records for one skill, including full body content for every section. Heavier than `get_skill_manifest`. Use it when you need to see the actual markdown.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `skillId` | `string` | yes | The skill ID. |

### Example input

```json
{ "name": "get_skill_sections", "arguments": { "skillId": "claude::test-rules::abcd1234" } }
```

### Example output (truncated)

```json
{
  "skillId": "claude::test-rules::abcd1234",
  "sections": [
    {
      "id": "claude::test-rules::abcd1234::setup",
      "title": "Setup",
      "content": "## Setup\n\nRun `npm install` once. ...\n",
      "hash": "sha256:...",
      "system": "claude",
      "sourcePath": "/Users/me/code/myproject/.claude/skills/test-rules/SKILL.md",
      "manifestId": "claude::test-rules::abcd1234",
      "class": "always",
      "policy": { "lines": ["..."], "alwaysInclude": true },
      "references": [],
      "tokenCount": 95,
      "byteLength": 412,
      "order": 0
    }
  ]
}
```

### When to use

Prefer `load_skill_context` when you want a budget-controlled context bundle for a query. Use `get_skill_sections` when you want the raw sections of one specific skill with no retrieval filtering.

---

## `load_skill_context`

The workhorse. Given a query (and optional phase and budget), return the minimum policy that applies, in the order it should apply. The retrieval layer is a deterministic compiler: always-on sections, then phase-matched sections, then BM25-lite matches, then budgeted references.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | no | Free-form query. Used for BM25-lite scoring against section text. |
| `phase` | `string` | no | Phase label, e.g. `planning`, `implementation`, `review`. Filters phase-class sections. |
| `includeReferences` | `boolean` | no | Include content from referenced files and URLs. Default: false. |
| `maxBytes` | `number` | no | Hard byte budget for the returned `context` string. Positive integer. |

If you pass only `query`, you get the legacy string-query behavior. If you pass `phase`, `includeReferences`, or `maxBytes`, you get the structured retrieval form with progressive controls.

### Example input (full)

```json
{
  "name": "load_skill_context",
  "arguments": {
    "query": "how should I structure a new feature",
    "phase": "planning",
    "includeReferences": false,
    "maxBytes": 4000
  }
}
```

### Example input (minimal)

```json
{ "name": "load_skill_context", "arguments": { "query": "test conventions" } }
```

### Example output

```json
{
  "sectionCount": 4,
  "content": "## Always-on policy\n\n...\n\n## Planning phase\n\n...\n\n## Matching sections\n\n...",
  "sections": [
    {
      "id": "claude::test-rules::abcd1234::setup",
      "title": "Setup",
      "class": "always",
      "policy": { "lines": ["..."], "alwaysInclude": true },
      "tokenCount": 95,
      "byteLength": 412
    }
  ],
  "references": [],
  "omitted": [
    { "id": "claude::test-rules::abcd1234::advanced", "reason": "budget" }
  ],
  "totalBytes": 3812
}
```

### Notes

- `content` is the formatted context string. Paste it into your prompt as-is.
- `sections` is the structured list of what made the cut, with classification and policy metadata. Use it to tell the user what rules you are about to apply.
- `omitted` lists sections that were eligible but dropped. `reason` is one of `budget` (hit `maxBytes`), `no_match` (no BM25 score above threshold), or `reference_unresolved` (a referenced file or URL could not be read).
- `references` is populated only when `includeReferences: true`.

### Empty cache

```json
{ "errors": ["no skills indexed"] }
```

Run `index_skills` first. See [agent-guide.md](agent-guide.md) for the bootstrap sequence.

### Stale cache

Same `rebuildRequired` shape as `list_skills`. Ruleloom refuses to return stale context, because the user asked for the truth, not a cached approximation.

---

## `load_section`

Load exactly one section by ID, plus the references it makes and a duplicate-reference report. Use this when you want to see one specific section in full, with cross-reference diagnostics.

### Arguments

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sectionId` | `string` | yes | The section ID. Get these from `get_skill_sections` or from the `sections` field of `load_skill_context`. |

### Example input

```json
{ "name": "load_section", "arguments": { "sectionId": "claude::test-rules::abcd1234::setup" } }
```

### Example output

```json
{
  "section": {
    "id": "claude::test-rules::abcd1234::setup",
    "title": "Setup",
    "content": "## Setup\n\nRun `npm install` once. ...\n",
    "hash": "sha256:...",
    "system": "claude",
    "sourcePath": "/Users/me/code/myproject/.claude/skills/test-rules/SKILL.md",
    "manifestId": "claude::test-rules::abcd1234",
    "class": "always",
    "policy": { "lines": ["Always run `npm test` before declaring a section done."], "alwaysInclude": true },
    "references": [],
    "tokenCount": 95,
    "byteLength": 412,
    "order": 0
  },
  "references": [
    "./helpers.ts"
  ],
  "duplicateRefs": ["README.md (2x)"]
}
```

### Duplicate reference detection

`duplicateRefs` lists any link target (wikilink or markdown link) that appears more than once in the section body. A duplicate usually means the section was copy-pasted across edits without cleanup. Treat it as a signal, not an error. The field is omitted entirely when no duplicates exist.

### Not found

```json
{ "errors": ["section \"claude::ghost::abcd1234::nope\" not found in index"] }
```

The section ID must come from a live index entry. Ruleloom refuses to return section files that are not in `index.json` (orphan files in the cache are ignored).

---

## Common shapes

### Error envelope

Every tool can return:

```json
{ "errors": ["message 1", "message 2"] }
```

The MCP response is `isError: true` in that case. The harness usually surfaces the `errors` array to the model verbatim.

### Stale index envelope

`list_skills`, `get_skill_manifest`, `get_skill_sections`, `load_skill_context`, and `load_section` all return the same `rebuildRequired` shape when sources have changed:

```json
{
  "errors": ["section \"X\" source changed; rerun index_skills"],
  "rebuildRequired": {
    "code": "REBUILD_REQUIRED",
    "action": "index_skills",
    "sectionIds": ["X"],
    "manifestIds": ["Y"],
    "reason": "source_changed"
  }
}
```

If you see this, the right move is to call `index_skills` (with `force: true` if you want a clean slate) and retry. Don't try to work around it by reading the cache directly. Ruleloom is refusing on purpose: the on-disk content no longer matches what was compiled.

### Conflict diagnostic envelope

Returned by `index_skills` and embedded in `get_skill_manifest`:

```json
{
  "conflictKey": "claude::test-rules",
  "winner": { "system": "claude", "sourcePath": "...", "sourceHash": "sha256:..." },
  "shadowed": [ { "system": "opencode", "sourcePath": "...", "sourceHash": "sha256:..." } ],
  "reason": "same_precedence_tiebreak",
  "winnerPrecedence": 80
}
```

`reason` is `higher_precedence` (one source had a higher precedence level and won outright) or `same_precedence_tiebreak` (same precedence level, deterministic tiebreak by source path, then source hash). The winner is what Ruleloom actually applied. The shadowed entries are still on disk and still hash to the same content. They were not used because the precedence rules said not to. The same `<system>::<skillName>` is the conflict key — the source-hash suffix is not part of it, so two builds with different source content collide under one key.
