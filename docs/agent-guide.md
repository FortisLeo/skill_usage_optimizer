# Agent Guide

This doc is for AI agents that have Ruleloom installed as an MCP server. The goal is to make the first few tool calls obvious, the steady state cheap, and the failure modes recoverable.

## Tool surface, in one sentence each

- `index_skills` writes the cache. Call it when sources have changed or on a cold start.
- `discover_skill_folders` is opt-in, bounded discovery of known roots and literal lowercase `skills` directories. Use `indexRoot` only from candidates marked `indexable`.
- `list_skills` reads the cache. Cheap, freshness-checked.
- `get_skill_manifest` reads one skill's summary. Use to inspect before loading.
- `get_skill_sections` reads one skill's full sections. Heavier than the manifest.
- `load_skill_context` returns formatted context for a query. The main read path.
- `load_section` returns one section plus its references and duplicate-link report.

Full schemas live in [tool-reference.md](tool-reference.md).

## First actions

When you discover Ruleloom on a user's machine, follow this order:

1. **Smoke test.** Call `list_skills` with no arguments. You should get back `{ "skills": [], "count": 0 }` on a fresh install, or a populated `skills` array after a prior indexing.
2. **Identify the systems in use.** Look at the user's repo, or explicitly call `discover_skill_folders` with `{}` for the project. Call it separately with `{ "scope": "home" }` only when home discovery is wanted. It recursively finds folders named exactly lowercase `skills`; it does not read content, inspect arbitrary files, accept `/` or another custom root, or scan the full machine. The walk is bounded and skips symlinks and common excluded directories. Candidate systems come from canonical `SOURCE_SYSTEMS`, but not every system has an indexable root; Aider config candidates are non-indexable.
3. **Index.** For a selected `indexable` candidate, call `index_skills` with its `system` and `roots: [candidate.indexRoot]`. Known roots keep their harness system; unknown harness `skills` folders report `generic`. Generic indexing rejects omitted or empty roots, so use `{ "system": "generic", "roots": [candidate.indexRoot] }`. Never pass `candidate.path`: it is root-relative display metadata and can be a file. `indexRoot` is already absolute for both project and home scans. Root instruction-file candidates are non-indexable because explicit roots are directories; normal system discovery handles them.
4. **Verify.** Call `list_skills` again and confirm the count matches the rule files you saw. If the count is zero, see [troubleshooting.md](troubleshooting.md).
5. **Pick the right system for follow-up reads.** `list_skills` accepts an optional `system` filter; pass it when you want only one slice. `get_skill_manifest`, `get_skill_sections`, `load_skill_context`, and `load_section` are system-agnostic — they work against whatever `skillId` or `sectionId` you give them.

That's the bootstrap. The rest of the work is the steady state below.

## When to index

Three reasons to call `index_skills`:

1. **Cold start.** The cache is empty or doesn't exist. The first `load_skill_context` call will return `{ "errors": ["no skills indexed"] }`. Index first, then read.
2. **Sources changed.** A `SKILL.md` was edited, a new rule file was added, or a conflicting rule appeared in a different system. If sources changed and you don't re-index, Ruleloom will refuse the next read with a `rebuildRequired` envelope. That's the system working as designed. Call `index_skills` to refresh.
3. **Conflict diagnostics wanted.** `index_skills` returns the full `diagnostics` array. `list_skills` only embeds a `conflictCount`. If you need to explain to the user which rules won and which were shadowed, re-index and read the response.

Don't index on every turn. Index when one of the three conditions above is true.

## When to load context

`load_skill_context` is the right tool when:

- The user asks a how-question ("how should I structure X", "what's our policy on Y").
- The user is about to start a task that has repo conventions: writing tests, opening a PR, deploying, refactoring.
- The user explicitly says "follow the rules" or "be careful about X".
- You're about to produce output that has repo-specific shape: commit messages, code style, file layout, naming.

It's the wrong tool when:

- The user wants the raw text of one specific rule file. Use `get_skill_sections` or just read the file.
- The user is asking a generic question with no repo-specific angle. The default prompt is fine.
- You're in the middle of a multi-turn task and the context has not changed. You loaded it once already. Don't reload unless something invalidated it.

### Choosing a phase

`phase` filters phase-class sections. Use it when the task has a clear lifecycle stage:

- `planning`: writing a plan, breaking down a feature, scoping work.
- `implementation`: writing code.
- `review`: reviewing a diff, running checks.
- `debugging`: chasing a failure.

The phase strings are free-form. Ruleloom matches them against section metadata. Use lowercase, single-word labels. If the user is clearly in a phase, pass it. If you're not sure, omit it. Ruleloom falls back to BM25-lite against the query.

### Choosing a budget

`maxBytes` is a hard cap on the `content` string. Use it when:

- The user has a small context window.
- The query is narrow and a tight bundle is enough.
- You want to keep the rest of the prompt room for the actual task.

A good starting point: 4000 bytes. Go up to 8000 for broad planning, down to 1500 for narrow follow-ups. If you don't pass a budget, Ruleloom returns whatever fits the default window.

## How to handle `rebuildRequired`

If a read tool returns the `rebuildRequired` envelope, the right response is:

1. Read the `action` field. It is always `index_skills`.
2. Read `sectionIds` and `manifestIds`. These are the affected slices. Both are `<system>::<skillName>::<hash8>` (and section IDs add the heading slug). Match the affected system by the `system` prefix and pass it to `index_skills`.
3. Call `index_skills` for the affected system. If you're not sure which system, use the `manifestIds` to figure it out (they start with `<system>::`, e.g. `claude::test-rules::abcd1234`).
4. Retry the original read.

Pass `force: true` only if you want a clean rebuild. Most of the time, an incremental re-index is enough.

Don't try to "fix" the cache by writing to `.skill-cache/` directly. Ruleloom owns that directory.

## How to explain conflict diagnostics

When `index_skills` returns `diagnostics`, the user is going to want to know:

1. **What's in conflict.** Look at `conflictKey`. It is always `<system>::<skillName>` — two or more rule files wrote to the same logical slot.
2. **Who won.** Look at `winner`. That's the source Ruleloom applied.
3. **Who got shadowed.** Look at `shadowed`. Those are the sources Ruleloom did not use. They are still on disk and still hash to the same content, but the precedence rules said the winner takes precedence.
4. **Why.** `reason` is `higher_precedence` (a clear precedence gap) or `same_precedence_tiebreak` (same precedence level, deterministic tiebreak by source path, then source hash). `winnerPrecedence` is the precedence value the winner carries.

When explaining to the user, name the files, the systems, and the precedence level. The user can usually resolve the conflict by either deleting one source or moving it to a higher-precedence location. Workspace rule files (under `.claude/`, `.opencode/`, etc.) win over global rule files. Workspace wins over explicit roots. System files (under `/etc/codex/skills/`) lose to everything. Within the same precedence level, Ruleloom does not prefer one system over another; it just tie-breaks by file path.

If the user says "use the shadowed one instead", don't try to do it at runtime. Tell them to either delete the winner or move it. Ruleloom's precedence is a contract, not a setting you can override per call.

## Working with policy lines

Sections can carry `policy.lines`, which is an array of hard rules with `alwaysInclude: true`. Ruleloom includes these in every load, even when they would normally be dropped for budget. Treat them as non-negotiable.

When you report back to the user, surface policy lines separately from the rest of the context. Something like:

> Two rules apply: "Always run `npm test` before declaring a section done" (hard policy, from `claude::test-rules::abcd1234`) and a suggestion to keep diffs under 200 lines (soft, from `claude::code-style::abcd1234`).

The user can tell the difference between a hard rule and a soft suggestion at a glance.

## Working with references

Sections can link to other files (via wikilinks `[[like this]]` or markdown links `[like this](path)`). When you pass `includeReferences: true` to `load_skill_context`, Ruleloom tries to read the referenced content. If a reference is unresolvable, the section still loads, and the omission appears in `omitted.reason: "reference_unresolved"`.

`load_section` returns the references of one section in full, plus a `duplicateRefs` list. Duplicates are not errors. They are a smell: a section that mentions the same file twice usually means the section was copy-pasted across edits. Mention it, then move on.

## Multi-system repos

Some repos carry rules for more than one system. Ruleloom indexes each system independently. If the same skill name appears in `.claude/skills/` and `.opencode/skills/`, the compile step picks a winner based on precedence, and the `diagnostics` array explains the choice.

A reasonable steady state for a multi-system repo:

1. `index_skills` for `claude`.
2. `index_skills` for `opencode`.
3. `index_skills` for `codex` if `.codex/` exists.
4. `index_skills` for `copilot` if `.github/instructions/` or `.github/copilot/` exists.
5. `list_skills` with no argument to see everything. Cross-check the conflict counts.

If the user only ever uses one harness, you can skip the other systems. Ruleloom is happy with a single-system index.

## Token budget math

Each `load_skill_context` call returns a `totalBytes` and a `sectionCount`. The `content` string is roughly `totalBytes` long. If the user has an 8K context budget for the rest of the conversation, leave at least 2x room and call with `maxBytes` around 4000. If you see `omitted[].reason: "budget"`, the budget is too tight for the question. Either raise `maxBytes` or narrow the query.

## What Ruleloom is not

- Not a vector database. It does not embed your rules. It does not retrieve by similarity to past conversations.
- Not a code search engine. For code search, use the host's native tools or something like GitNexus.
- Not a rules linter. It does not tell you your rules are bad. It tells you which rules apply.

If you want a RAG-style fuzzy search over arbitrary files, look elsewhere. Ruleloom is a deterministic compiler with a small fuzzy fallback for the "I don't know which section applies" case. Everything else is exact.

## See also

- [examples.md](examples.md): realistic end-to-end flows.
- [troubleshooting.md](troubleshooting.md): what to do when something is wrong.
- [tool-reference.md](tool-reference.md): full tool schemas.
