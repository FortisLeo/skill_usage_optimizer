# Examples

End-to-end flows. Each example shows a realistic sequence of tool calls and what you should see in the responses. Names and content are illustrative; the shape is what Ruleloom actually returns.

The examples assume the user has a repo with this layout:

```
myproject/
  .claude/
    skills/
      test-rules/SKILL.md
      code-style/SKILL.md
      pr-workflow/SKILL.md
  .opencode/
    rules/
      test-rules.md       # same name as .claude/skills/test-rules
  .github/
    instructions/
      commit-message.instructions.md
```

That's a multi-system repo on purpose, so we can show the conflict path.

---

## Example 1: index a repo

The user opens a fresh project. Ruleloom is installed but the cache is empty. The agent should index every system the repo uses, then verify.

### Step 1: smoke test

```json
{ "name": "list_skills", "arguments": {} }
```

Expected response:

```json
{ "skills": [], "count": 0 }
```

The agent sees an empty cache. The next step is to look at the repo layout.

### Step 2: index Claude

The user is in Claude Code. Index the Claude system.

```json
{ "name": "index_skills", "arguments": { "system": "claude", "baseDir": "/Users/me/code/myproject" } }
```

Expected response:

```json
{
  "indexedSkills": 3,
  "indexedSections": 11,
  "errors": []
}
```

Three skills (`test-rules`, `code-style`, `pr-workflow`), eleven sections total, no errors, no conflicts yet.

### Step 3: index OpenCode

Same repo has `.opencode/rules/`. Index OpenCode too.

```json
{ "name": "index_skills", "arguments": { "system": "opencode", "baseDir": "/Users/me/code/myproject" } }
```

Expected response:

```json
{
  "indexedSkills": 1,
  "indexedSections": 4,
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

The OpenCode version of `test-rules` is shadowed. Both files sit at the same `workspace_root` precedence (80), so Ruleloom uses the deterministic tie-break (lower source path wins; `.claude/...` sorts before `.opencode/...`). The agent should report this to the user.

### Step 4: index Copilot

The repo has `.github/instructions/`. Index Copilot.

```json
{ "name": "index_skills", "arguments": { "system": "copilot", "baseDir": "/Users/me/code/myproject" } }
```

Expected response:

```json
{
  "indexedSkills": 1,
  "indexedSections": 1,
  "errors": []
}
```

One skill from `commit-message.instructions.md`. Note: Copilot's `instruction_file` kind usually maps to a single section. Don't expect a heavy taxonomy.

### Step 5: verify

```json
{ "name": "list_skills", "arguments": {} }
```

Expected response (truncated):

```json
{
  "skills": [
    { "id": "claude::test-rules::aaaa1111", "skillName": "test-rules", "system": "claude", "sectionCount": 4, "tokenCount": 812, "byteLength": 3478, "kind": "skill_package", "description": "Conventions for writing tests.", "precedence": 80, "conflictCount": 0 },
    { "id": "claude::code-style::aaaa2222", "skillName": "code-style", "system": "claude", "sectionCount": 3, "tokenCount": 540, "byteLength": 2104, "kind": "skill_package", "description": "Code style for this repo.", "precedence": 80, "conflictCount": 0 },
    { "id": "claude::pr-workflow::aaaa3333", "skillName": "pr-workflow", "system": "claude", "sectionCount": 4, "tokenCount": 730, "byteLength": 2890, "kind": "skill_package", "description": "PR workflow.", "precedence": 80, "conflictCount": 0 },
    { "id": "opencode::test-rules::bbbb1111", "skillName": "test-rules", "system": "opencode", "sectionCount": 4, "tokenCount": 600, "byteLength": 2500, "kind": "rule_file", "description": null, "precedence": 80, "conflictCount": 1 },
    { "id": "copilot::commit-message::cccc1111", "skillName": "commit-message", "system": "copilot", "sectionCount": 1, "tokenCount": 180, "byteLength": 720, "kind": "instruction_file", "description": null, "precedence": 80, "conflictCount": 0 }
  ],
  "count": 5
}
```

Five skills, two of them with `conflictCount: 1`. The agent can decide whether to surface the conflict to the user. For most flows, a one-line mention is enough.

---

## Example 2: list skills before planning

The user says "I want to add a new command-line flag to the build script. What are the rules?"

### Step 1: list

```json
{ "name": "list_skills", "arguments": {} }
```

The agent scans the result. `code-style`, `pr-workflow`, `test-rules` look relevant. `commit-message` is too narrow. The agent picks two to inspect.

### Step 2: inspect manifest of code-style

```json
{ "name": "get_skill_manifest", "arguments": { "skillId": "claude::code-style::aaaa2222" } }
```

The agent reads the manifest. Three sections, one of them is `class: "always"`, the other two are `class: "phase"` with phase labels like `implementation` and `review`. The `always` section has `policy.alwaysInclude: true` with hard rules like "use 2-space indent" and "no unused exports."

### Step 3: inspect manifest of pr-workflow

```json
{ "name": "get_skill_manifest", "arguments": { "skillId": "claude::pr-workflow::aaaa3333" } }
```

Four sections: `title`, `body`, `review-process`, `merge`. All `class: "phase"` except `review-process` which is `on_demand`.

### Step 4: load context for the actual task

```json
{
  "name": "load_skill_context",
  "arguments": {
    "query": "adding a new CLI flag to the build script",
    "phase": "implementation",
    "maxBytes": 4000
  }
}
```

Expected response (shape):

```json
{
  "sectionCount": 4,
  "content": "## Always-on policy\n\n- use 2-space indent\n- no unused exports\n\n## Implementation phase\n\n### code-style: naming\n\n...\n\n### pr-workflow: title\n\n...",
  "sections": [
    { "id": "claude::code-style::aaaa2222::always", "class": "always", "policy": { "lines": ["use 2-space indent", "no unused exports"], "alwaysInclude": true } },
    { "id": "claude::code-style::aaaa2222::naming", "class": "phase", "tokenCount": 220, "byteLength": 870 },
    { "id": "claude::pr-workflow::aaaa3333::title", "class": "phase", "tokenCount": 110, "byteLength": 440 },
    { "id": "claude::pr-workflow::aaaa3333::body", "class": "phase", "tokenCount": 180, "byteLength": 720 }
  ],
  "omitted": [
    { "id": "claude::pr-workflow::aaaa3333::review-process", "reason": "no_match" },
    { "id": "claude::pr-workflow::aaaa3333::merge", "reason": "budget" }
  ],
  "totalBytes": 3812
}
```

The agent pastes `content` into the prompt, mentions the two hard rules from the `always` section explicitly, and gets to work.

---

## Example 3: load context for a planning task

The user says "I want to plan a refactor of the auth module. What does the repo say about planning?"

```json
{
  "name": "load_skill_context",
  "arguments": {
    "query": "refactor auth module planning",
    "phase": "planning",
    "maxBytes": 6000
  }
}
```

Expected shape:

```json
{
  "sectionCount": 5,
  "content": "## Always-on policy\n\n- ...\n\n## Planning phase\n\n### code-style: planning-checklist\n\n...\n\n### pr-workflow: planning\n\n...\n\n## Matching sections\n\n..."
}
```

The agent can see which skills contribute to the planning phase and which sections are eligible. If `omitted[].reason: "budget"` shows up, raise `maxBytes` or split the question.

---

## Example 4: inspect a manifest before loading

The user says "show me everything `test-rules` knows."

### Step 1: manifest

```json
{ "name": "get_skill_manifest", "arguments": { "skillId": "claude::test-rules::aaaa1111" } }
```

The agent reads the manifest. It has four sections: `setup`, `structure`, `naming`, `cleanup`. `cleanup` is `class: "on_demand"`. The others are `class: "always"`. The agent decides to load the manifest first to confirm before pulling content.

### Step 2: sections

```json
{ "name": "get_skill_sections", "arguments": { "skillId": "claude::test-rules::aaaa1111" } }
```

The agent gets full content for all four sections. If the user only wants one, the agent switches to `load_section`:

```json
{ "name": "load_section", "arguments": { "sectionId": "claude::test-rules::aaaa1111::cleanup" } }
```

That returns one section plus its references and any duplicate-link report.

---

## Example 5: load one exact section

The user says "what does the cleanup section of test-rules say?"

```json
{ "name": "load_section", "arguments": { "sectionId": "claude::test-rules::aaaa1111::cleanup" } }
```

Expected response:

```json
{
  "section": {
    "id": "claude::test-rules::aaaa1111::cleanup",
    "title": "Cleanup",
    "content": "## Cleanup\n\nDelete temporary files in `afterEach`. ...\n",
    "hash": "sha256:...",
    "system": "claude",
    "sourcePath": "/Users/me/code/myproject/.claude/skills/test-rules/SKILL.md",
    "manifestId": "claude::test-rules::aaaa1111",
    "class": "on_demand",
    "policy": null,
    "references": [{ "target": "./helpers.ts", "kind": "file", "resolved": true, "absolutePath": "/Users/me/code/myproject/.claude/skills/test-rules/helpers.ts" }],
    "tokenCount": 95,
    "byteLength": 412,
    "order": 3
  },
  "references": ["./helpers.ts"]
}
```

The `duplicateRefs` field is omitted entirely when no link or wikilink target appears more than once. When duplicates exist, it is an array of `"<target> (<count>x)"` strings. See [tool-reference.md](tool-reference.md#duplicate-reference-detection).

The agent can quote `content` directly or follow the `references` if the user wants more depth.

---

## Example 6: explain a conflict

The user says "I have a `test-rules` skill in both `.claude/` and `.opencode/`. Which one is being used?"

### Step 1: list with conflicts visible

```json
{ "name": "list_skills", "arguments": {} }
```

Both entries appear in the response, each with `conflictCount: 1`. The agent sees the conflict but doesn't have the full diagnostic yet.

### Step 2: get full diagnostic by re-indexing

```json
{ "name": "index_skills", "arguments": { "system": "opencode", "force": true } }
```

The response includes a `diagnostics` array. The agent reads it and reports:

> Two sources define `test-rules`:
>
> - Winner: `.claude/skills/test-rules/SKILL.md` (precedence 80, the workspace Claude rule — won by source-path tie-break).
> - Shadowed: `.opencode/rules/test-rules.md` (precedence 80, the workspace OpenCode rule).
>
> Ruleloom is using the Claude version. To switch, move the OpenCode file or delete the Claude one.

The user can now decide.

---

## Example 7: handle a stale index

The user edits `.claude/skills/test-rules/SKILL.md` and adds a new section. The next `load_skill_context` call returns:

```json
{
  "errors": ["section \"claude::test-rules::cleanup\" source changed; rerun index_skills"],
  "rebuildRequired": {
    "code": "REBUILD_REQUIRED",
    "action": "index_skills",
    "sectionIds": ["claude::test-rules::cleanup"],
    "manifestIds": ["claude::test-rules"],
    "reason": "source_changed"
  }
}
```

The agent does not try to bypass this. It calls:

```json
{ "name": "index_skills", "arguments": { "system": "claude" } }
```

Then retries the original `load_skill_context` call. The new section is now part of the bundle.

---

## Example 8: budget tuning

The user has a small context window. The agent calls `load_skill_context` with `maxBytes: 1500`. The response includes `omitted[]` full of `"reason": "budget"` entries.

The agent raises the budget to 4000 and retries. The `omitted` list shrinks. If the user has plenty of context room, the agent drops `maxBytes` and lets Ruleloom return a fuller bundle.

A good heuristic:

- 1500 bytes: narrow follow-up question, single skill.
- 4000 bytes: planning or implementation, one to three skills.
- 8000 bytes: broad planning, multi-skill, references included.
- No `maxBytes`: the full default window. Use only when the user has a very large context or explicitly asks for the whole policy.

---

## Example 9: a wrong-rule diagnosis

The user complains: "I told you to follow the global rule and you used the workspace one."

The agent reads `get_skill_manifest` for the skill in question. The `precedence` field is 100. Globals are precedence 40. The workspace one wins. That is the design: workspace beats global.

The agent explains:

> Workspace rules under `.claude/`, `.opencode/`, `.codex/`, or `.github/instructions/` always win over global rules under `~/.claude/`, `~/.config/opencode/`, or `~/.codex/`. To make the global rule win, you have to delete or move the workspace rule.

If the user wants the global rule applied, the move is on the filesystem, not in Ruleloom.

---

## Example 10: an empty repo

The user is in a brand-new directory with no rule files anywhere.

```json
{ "name": "index_skills", "arguments": { "system": "claude" } }
```

Returns:

```json
{ "indexedSkills": 0, "indexedSections": 0, "errors": [] }
```

The agent reports: "No Claude rules found in this repo or your global config. Ruleloom is indexed and ready; add a `.claude/skills/<name>/SKILL.md` and re-run `index_skills`."

If the user expected rules and none are there, the issue is on the filesystem, not in Ruleloom. Confirm with `ls -la` (or the equivalent on Windows) that the rule files exist where Ruleloom expects them.
