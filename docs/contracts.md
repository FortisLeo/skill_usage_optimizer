# Shared Contracts (Track A)

**Status:** Frozen for Track A with approved result-object revision (2026-07-04).

## Core Types

```typescript
export const SOURCE_SYSTEMS = ['claude', 'opencode', 'codex', 'copilot', 'cursor', 'gemini', 'windsurf', 'cline', 'roo', 'continue', 'aider', 'generic'] as const;
export type SourceSystem = typeof SOURCE_SYSTEMS[number];

export type SectionClass = 'always' | 'phase' | 'on_demand' | 'reference';

export type ArtifactKind =
  | 'skill_package'
  | 'instruction_file'
  | 'rule_file'
  | 'convention_file'
  | 'pseudo_skill';

export interface DiscoveryContext {
  workspaceRoot: string;
  repoRoot: string | null;
  homeDir: string;
  includeGlobals: boolean;
  includeSystem: boolean;
  explicitRoots: string[];
  /** Limit adapter dispatch for a system-specific index request. */
  requestedSystem?: SourceSystem;
  /** Attribute arbitrary explicit roots to this system; heuristic fallback still applies when absent. */
  explicitRootSystem?: SourceSystem;
  /** Test seam: override the Codex system skills directory. */
  codexSystemRoot?: string;
}

export interface DiscoveredArtifact {
  system: SourceSystem;
  kind: ArtifactKind;
  absolutePath: string;
  relativePath: string;
  rootOrigin: string;
  precedence: number;
  /** null unless discovery followed a config-file indirection. */
  configIndirection: string | null;
  rawStat: { mtimeMs: number; size: number };
}

export interface NormalizedSkillInput {
  system: SourceSystem;
  kind: ArtifactKind;
  skillName: string;
  description: string | null;
  rawMarkdown: string;
  frontmatter: Record<string, unknown>;
  attachments: string[];
  sourcePath: string;
  sourceHash: string;
  mtimeMs: number;
  size: number;
  precedence: number;
}

export interface SkillSourceRef {
  system: SourceSystem;
  sourcePath: string;
  sourceHash: string;
}

export interface SkillConflictDiagnostic {
  conflictKey: string;
  winner: SkillSourceRef;
  shadowed: SkillSourceRef[];
  reason: 'higher_precedence' | 'same_precedence_tiebreak';
  winnerPrecedence: number;
}

export interface DiscoveryDiagnostic {
  environment: SourceSystem;
  capability: 'roots' | 'configuration' | 'runtime_bridge';
  sourceType: 'roots' | 'configuration' | 'runtime' | 'explicit';
  status: 'used' | 'fallback' | 'unavailable' | 'limited' | 'truncated' | 'skipped';
  code:
    | 'SOURCE_USED' | 'SOURCE_ABSENT' | 'SOURCE_UNAVAILABLE'
    | 'SOURCE_UNSUPPORTED' | 'SOURCE_INVALID' | 'SOURCE_UNSAFE'
    | 'SOURCE_INACCESSIBLE' | 'SOURCE_TRUNCATED' | 'WORKSPACE_MISMATCH';
  foundCount: number;
  skippedCount: number;
  limitation: string;
  explicitRootGuidance: string;
}
```

## Module API Boundaries

```typescript
// discovery
export function discover(ctx: DiscoveryContext): DiscoverResult;

// normalization
export function normalize(
  artifacts: DiscoveredArtifact[],
  ctx: DiscoveryContext
): NormalizeResult;

// compiler
export function compile(
  inputs: NormalizedSkillInput[],
  ctx: DiscoveryContext
): CompileResult;

// retrieval
export function loadContext(
  store: SkillStore,
  queryOrRequest: string | RetrievalRequest
): RetrievalBundle;
```

## SkillStore Contract

The compiler output (`SkillStore`) may be represented as either
`Map<string, SkillSection>` or `Record<string, SkillSection>`. Consumers
must accept either form. `loadContext` accepts both.

```typescript
export interface SkillSection {
  id: string;
  title: string;
  content: string;
  hash: string;
  system?: SourceSystem;
  sourcePath?: string;
  sourceHash?: string;
  mtimeMs?: number;
  size?: number;
  manifestId?: string;
  class?: SectionClass;
  policy?: MandatoryPolicy;
  references?: ReferenceRef[];
  tokenCount?: number;
  byteLength?: number;
  order?: number;
  precedence?: number;
  requires?: string[];
  related?: RelatedEdge[];
  provides?: string[];
  uses?: string[];
  flowOf?: string[];
  summary?: string;
  keywords?: string[];
  lineRange?: [number, number];
  startAnchor?: { text: string; level: number };
  contentSha256?: string;
  oversized?: boolean;
}

export type SkillStore = Map<string, SkillSection> | Record<string, SkillSection>;

export interface RelatedEdge {
  id: string;
  weight: number;
  source: 'author' | 'inferred' | 'learned';
}

export interface FlowNode {
  id: string;
  summary: string;
  steps: string[];
}

export interface ResolveRequest {
  query: string;
  phase?: string;
  skill?: string;
  budget?: number;
  includeSoft?: boolean;
  k?: number;
}

export interface ResolvedSection {
  id: string;
  headingPath: string[];
  content: string;
  role: 'hard' | 'soft';
  order: number;
  trustTier: string;
}

export interface ResolveResult {
  query: string;
  seed: string;
  matchedFlow?: string;
  collapsed: boolean;
  sections: ResolvedSection[];
  leftovers: string[];
  budget: { limit: number; used: number };
}

export interface MandatoryPolicy {
  lines: string[];
  alwaysInclude: boolean;
}

export interface ReferenceRef {
  target: string;
  kind: 'file' | 'url' | 'skill';
  resolved?: boolean;
  absolutePath?: string;
  sourceRoot?: string;
}

export interface LoadedReference {
  ref: ReferenceRef;
  content?: string;
}

export interface OmittedItem {
  id: string;
  reason: 'budget' | 'no_match' | 'reference_unresolved';
}

export interface RetrievalRequest {
  query?: string;
  phase?: string;
  includeReferences?: boolean;
  maxBytes?: number;
}

export interface ManifestSectionRef {
  id: string;
  title: string;
  class: SectionClass;
  tokenCount: number;
  byteLength: number;
  references: ReferenceRef[];
  policy?: MandatoryPolicy;
  order: number;
}

export interface SkillManifest {
  id: string;
  skillName: string;
  system: SourceSystem;
  kind: ArtifactKind;
  description: string | null;
  sourcePath: string;
  sourceHash: string;
  sections: ManifestSectionRef[];
  tokenCount: number;
  byteLength: number;
  precedence?: number;
  conflicts?: SkillConflictDiagnostic[];
}

export interface RetrievalBundle {
  sections: SkillSection[];
  context: string;
  references?: LoadedReference[];
  omitted?: OmittedItem[];
  totalBytes?: number;
}
```

## Stable ID Collision Resolution

When duplicate headings or body-hash collisions produce the same section ID,
the compiler applies a deterministic fallback:

1. First append `-<shortHash>` where `shortHash` is the first 8 hex chars of
   SHA-256(body).
2. If that still collides, append a stable numeric counter (`-2`, `-3`, …)
   in encounter order.

## Result Object Contracts

Cross-module functions that produce collections or may encounter errors
return a plain result object. Utility functions (e.g. `loadContext`) may
return values directly. No uncaught exceptions escape module boundaries.

```typescript
export type BoundaryError = { path: string; error: string };

export interface DiscoverResult {
  artifacts: DiscoveredArtifact[];
  errors: BoundaryError[];
  discoveryDiagnostics?: DiscoveryDiagnostic[];
}

export interface NormalizeResult {
  inputs: NormalizedSkillInput[];
  errors: BoundaryError[];
}

export interface CompileResult {
  store: SkillStore;
  errors: BoundaryError[];
  manifests?: SkillManifest[];
  diagnostics?: SkillConflictDiagnostic[];
}
```

- Errors inside a module are captured into the result's `errors` array.
- Callers inspect `errors` to decide whether to abort or continue.
- Empty `errors` means success; non-empty does not imply total failure — the
  result still contains whatever partial output was produced.
- Uncaught throws across a module boundary are a contract violation. Each
  module wraps its top-level entry point in a try/catch that converts
  unexpected errors into a `{ path: '<track>', error: string }` entry.

`discoveryDiagnostics` is additive, response-only metadata for non-fatal
source limitations. It is capped at 100 entries; text fields are capped at
256 UTF-8 bytes, redact source paths and payloads, and counts never exceed the
shared scanner limits. These entries never abort indexing or persist to the
index, sections, manifests, or savings data. Invalid explicit roots and
pipeline-wide failures remain fatal `errors`. Compiler conflicts remain in the
separate `diagnostics` field.

Artifact dedupe uses canonical real paths. Higher precedence wins; equal
precedence uses the static source-system order `claude`, `opencode`, `codex`,
`copilot`, `cursor`, `gemini`, `windsurf`, `cline`, `roo`, `continue`, `aider`, `generic`, then the existing static source encounter order.

## Agent environment contract: Claude Code

- **sourceSystem / capability:** `claude`; documented project, nested, and user roots plus explicit roots. Plugin-installed/runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Anthropic (`anthropics/claude-code`), verified 2026-07-15 against the latest release v2.1.209 (published 2026-07-14) and the official documentation available on 2026-07-15. The documentation is continuously updated rather than release-versioned, so later releases require re-verification. Nested project skills require Claude Code v2.1.203 or later; Ruleloom's confirmed contract target is v2.1.209.
- **Evidence:** [Skills](https://code.claude.com/docs/en/skills), [Memory and rules](https://code.claude.com/docs/en/memory), [Settings scopes](https://code.claude.com/docs/en/settings), [Plugins](https://code.claude.com/docs/en/plugins), and [v2.1.209](https://github.com/anthropics/claude-code/releases/tag/v2.1.209).
- **Supported OSes:** documented project and user paths on Claude Code platforms; `~` is resolved through the supplied home directory on macOS, Linux/WSL, and Windows. Managed-policy roots are not scanned.
- **Project sources:** `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/skills/<name>/SKILL.md`, legacy `.claude/commands/**/*.md`, and recursive `.claude/rules/**/*.md` under each supplied workspace/repository endpoint. Nested `CLAUDE.md`/`CLAUDE.local.md` files and nested `.claude/skills/` roots are discovered within the fixed project traversal depth. `AGENTS.md` is not a native Claude Code instruction file and is not attributed to `claude`.
- **Global sources:** `~/.claude/CLAUDE.md`, `~/.claude/skills/`, legacy `~/.claude/commands/`, and `~/.claude/rules/` when global discovery is enabled.
- **Ordering and precedence:** existing Ruleloom precedence is unchanged: repository 100, workspace 80, explicit 70, global 40, system 10. Canonical-path dedupe and static source order are unchanged, and every documented/explicit source is forcibly attributed to `claude`. Ruleloom indexes sources independently; it does not reproduce Claude Code's skill-name override, nested qualified-name, lazy-load, or final context ordering.
- **Bounds and path policy:** every supplied source uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Project root discovery is separately capped at 10,000 entries and depth 3. Symlinks, escapes, inaccessible entries, generated directories, `node_modules`, dependency trees, and plugin caches are skipped; no source content is read while locating roots.
- **Lifecycle/invalidation/cleanup:** discovery reads current files on each index operation and uses the existing normalize, compile, store, stale-pruning, and atomic live-index behavior. The adapter creates no Claude Code state or handoff.
- **Fallback and diagnostics:** absent, limited, unsafe, or inaccessible optional sources are non-fatal `discoveryDiagnostics`. Unavailable plugin/runtime-effective resolution emits `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** Claude Code documents plugin skill layout, but no stable API or single canonical effective-source location was confirmed for resolving installed, enabled, versioned, managed, marketplace, and development plugins without cache or settings reconstruction. Ruleloom therefore does not inspect `~/.claude/plugins`, package/dependency caches, settings payloads, managed policy files, `--add-dir` sources, auto memory, imports, hooks, MCP state, final prompts, or session state. Add trusted unsupported directories through explicit roots.

## Agent environment contract: OpenCode

- **sourceSystem / capability:** `opencode`; documented roots plus explicit roots. Runtime bridge and effective configuration discovery are not shipped.
- **Verified owner and date:** OpenCode (`anomalyco/opencode`), verified 2026-07-15 against release v1.18.0 (published 2026-07-14) and the official documentation updated 2026-07-14. The documentation is not separately versioned, so later releases require re-verification.
- **Evidence:** [Agent Skills](https://opencode.ai/docs/skills/), [Rules](https://opencode.ai/docs/rules/), [Config](https://opencode.ai/docs/config/), [Plugins](https://opencode.ai/docs/plugins/), and [v1.18.0](https://github.com/anomalyco/opencode/releases/tag/v1.18.0).
- **Supported OSes:** documented project paths on every OpenCode platform; global paths are resolved relative to the supplied home directory on macOS, Linux, and Windows. Managed/system config locations are not scanned.
- **Project skill roots:** `.opencode/skills/`, backward-compatible `.opencode/skill/`, `.claude/skills/`, and `.agents/skills/` under the supplied workspace and repository roots.
- **Global skill roots:** `~/.config/opencode/skills/`, backward-compatible `~/.config/opencode/skill/`, `~/.claude/skills/`, and `~/.agents/skills/` when global discovery is enabled.
- **Rule/instruction files:** project `AGENTS.md`, falling back to project `CLAUDE.md`; global `~/.config/opencode/AGENTS.md`, falling back to `~/.claude/CLAUDE.md`. Only the first present file in each fallback pair is scanned.
- **Ordering and precedence:** existing Ruleloom precedence is unchanged: repository 100, workspace 80, explicit 70, global 40, system 10. Canonical-path dedupe and static source order remain unchanged. `index_skills(system: "opencode")` dispatches only the OpenCode adapter so compatible `.claude` sources retain forced `opencode` attribution.
- **Bounds and path policy:** each supplied root uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Every entry must resolve inside its individual source root and allowed roots; symlinks, escapes, inaccessible entries, `node_modules`, and hidden nested directories are skipped. No cache or dependency-tree root is enumerated.
- **Lifecycle/invalidation/cleanup:** discovery reads current files on each index operation and uses the existing normalize, compile, store, stale-pruning, and atomic live-index behavior. This adapter creates no handoff or host state.
- **Fallback and diagnostics:** absent, limited, or unsafe optional sources are non-fatal `discoveryDiagnostics`. The unavailable runtime-effective plugin-path source emits `runtime_bridge` / `runtime` / `SOURCE_UNSUPPORTED` plus `index_skills.roots` guidance. Explicit-root boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom does not read `config.skills.paths`, `opencode.json` `instructions` globs or URLs, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, inline, remote, managed, or plugin-merged effective configuration. It does not inspect `~/.cache/opencode/node_modules`, package caches, plugins, final prompts, or session state. It checks only the supplied workspace/repository endpoints rather than reproducing OpenCode's full cwd-to-worktree walk. Claude compatibility disable environment variables are not evaluated. Runtime-effective coverage requires the separately verified writer and reader units; it is not claimed here.

## Agent environment contract: Codex CLI

- **sourceSystem / capability:** existing public ID `codex`; documented AGENTS hierarchy, repository/user skills, repository/user custom agents, opt-in admin skills, and explicit roots. Plugin/runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** OpenAI (`openai/codex`), verified 2026-07-15 against latest stable Codex CLI 0.144.4 (published 2026-07-14) and the official documentation available 2026-07-15. The documentation is continuously updated rather than release-versioned, so later releases require re-verification.
- **Evidence:** [AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md/), [Build skills](https://developers.openai.com/codex/build-skills/), [Subagents/custom agents](https://developers.openai.com/codex/agent-configuration/subagents/), [Config basics](https://developers.openai.com/codex/config-file/config-basic/), [Admin rollout](https://developers.openai.com/codex/enterprise/admin-setup/), and [0.144.4](https://github.com/openai/codex/releases/tag/rust-v0.144.4).
- **Supported OSes:** documented repository and user locations are resolved from supplied paths on Codex CLI platforms. `/etc/codex/skills` is Unix-only and remains disabled unless `includeSystem` is explicitly enabled.
- **Project sources:** from the supplied repository root down to the supplied workspace endpoint, each directory contributes at most one non-empty instruction file (`AGENTS.override.md` before `AGENTS.md`), `.agents/skills/<name>/SKILL.md`, and flat `.codex/agents/*.toml` custom-agent definitions.
- **Global sources:** `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md`, `~/.agents/skills/<name>/SKILL.md`, and `~/.codex/agents/*.toml` when global discovery is enabled. The supplied home directory defines `~`.
- **System source:** `/etc/codex/skills/<name>/SKILL.md` only when system discovery is opted in. Bundled OpenAI system skills have no documented filesystem/API contract and are not scanned.
- **Ordering and precedence:** AGENTS files follow the confirmed root-to-workspace hierarchy and same-directory override selection. Existing Ruleloom precedence is preserved: repository 100, workspace 80, explicit 70, global 40, system 10. Canonical-path dedupe and static source order are unchanged, and all adapter/explicit artifacts are forcibly attributed to `codex`. Ruleloom stores sources independently rather than reconstructing Codex's merged prompt.
- **Bounds and path policy:** every root uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Custom-agent enumeration is flat and bounded. Ruleloom rejects symlinks and escapes even though Codex itself documents symlinked skill support; this stricter policy preserves source-root containment.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter creates no Codex state or handoff.
- **Fallback and diagnostics:** absent, limited, unsafe, or inaccessible optional sources are non-fatal `discoveryDiagnostics`. Unsupported configuration/runtime-effective resolution emits `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with exact `index_skills.roots` guidance. Explicit-root boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom does not parse `.codex/config.toml`, `project_doc_fallback_filenames`, `project_doc_max_bytes`, project trust, `project_root_markers`, profiles, hooks, rules, managed requirements/configuration, alternate `CODEX_HOME`, plugin marketplaces/installations, bundled skills, session logs, final prompts, or runtime state. Custom-agent TOML files are indexed as complete local instruction artifacts; Ruleloom does not emulate agent inheritance. Add trusted alternate roots explicitly. No cache, package tree, or SDK is crawled.

## Agent environment contract: GitHub Copilot / VS Code

- **sourceSystem / capability:** existing public ID `copilot`; confirmed local repository, compatibility, personal filesystem roots, and explicit roots. Runtime-applied instruction discovery is not shipped.
- **Verified owner, version, and date:** Microsoft VS Code and GitHub Copilot, verified 2026-07-15 against VS Code stable 1.128 (released 2026-07-08; current 1.128.1 servicing update) and official VS Code/GitHub documentation last updated 2026-07-08 or available 2026-07-15. The web documentation and GitHub service are continuously updated rather than pinned to a Copilot extension/service version, so later VS Code releases require re-verification.
- **Evidence:** [VS Code 1.128](https://code.visualstudio.com/updates/v1_128), [custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), [Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills), [prompt files](https://code.visualstudio.com/docs/agent-customization/prompt-files), [custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents), and [GitHub repository custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot).
- **Supported OSes:** workspace roots are platform-independent. Confirmed personal `~/.copilot`, `~/.claude`, and `~/.agents` paths are resolved through the supplied home directory on VS Code platforms. Profile-specific VS Code user data is not scanned because the official contract deliberately exposes it as profile-managed user data rather than one portable canonical filesystem root.
- **Project instructions:** `.github/copilot-instructions.md`; recursive `.github/instructions/**/*.instructions.md`; root `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, and `.claude/CLAUDE.md`; recursive `.claude/rules/**/*.md`. Copilot `applyTo` and Claude `paths` frontmatter survive normalization, but Ruleloom has no target-file input and therefore does not claim to enforce those globs during retrieval.
- **Project skills, prompts, and agents:** `.github/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`; flat `.github/prompts/*.prompt.md`; flat `.github/agents/*.md` and `.claude/agents/*.md`.
- **Global sources:** `~/.copilot/instructions/**/*.instructions.md`, `~/.claude/rules/**/*.md`, `~/.copilot/skills/<name>/SKILL.md`, `~/.claude/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`, flat `~/.copilot/agents/*.agent.md`, and `~/.claude/CLAUDE.md` when global discovery is enabled.
- **Ordering and precedence:** existing Ruleloom precedence is preserved: repository 100, workspace 80, explicit 70, global 40, system 10, with canonical-realpath dedupe and static source order. Every compatible source is forcibly attributed to `copilot`. VS Code states that combined project instruction files have no guaranteed order and gives personal instructions higher host priority than repository instructions; Ruleloom stores sources independently and does not reconstruct that final host ordering.
- **Bounds and path policy:** every source uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Recursive instruction roots and flat prompt/agent roots use the same entry/result safety state. Symlinks, escapes, inaccessible entries, hidden nested directories, `node_modules`, and cache/dependency trees are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no VS Code or Copilot state.
- **Fallback and diagnostics:** absent or unsafe optional roots are non-fatal `discoveryDiagnostics`. A `configuration` / `configuration` / `SOURCE_UNSUPPORTED` diagnostic records unsupported runtime diagnostics, profile user data, configured extra locations, and organization sources, with exact `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** VS Code exposes loaded-customization diagnostics only through UI/debug surfaces; no stable machine-readable API suitable for this adapter was confirmed. Ruleloom therefore does not inspect Chat Diagnostics, Agent Debug Logs, model requests, references, extension state, profile user data, Settings Sync, organization instructions/agents, extension-contributed or plugin skills, settings payloads, `chat.*FilesLocations`, parent-repository settings, or runtime/final prompts. Nested `AGENTS.md` support in VS Code remains experimental and is not crawled; GitHub cloud-agent nearest-file behavior is not reconstructed. Prompt files in profile user data have no confirmed portable root. Pass each trusted unsupported directory through `index_skills.roots`.

## Agent environment contract: Cursor

- **sourceSystem / capability:** canonical public ID `cursor`; confirmed project rules/instructions, project and user skill roots, legacy `.cursorrules` compatibility, and explicit roots. User/team rule storage, command roots, and runtime-effective discovery are not shipped.
- **Verified owner, version, and date:** Cursor/Anysphere, verified 2026-07-15 against the current Cursor 3.11 release (released 2026-07-10) and official documentation available 2026-07-15. Agent Skills were introduced in Cursor 2.4; this contract targets the current 3.11 documentation and must be re-verified after contract changes.
- **Evidence:** [Cursor 3.11 changelog](https://cursor.com/changelog), [Cursor 2.4 Agent Skills release](https://cursor.com/changelog/2-4), [Rules](https://cursor.com/docs/rules.md), [Agent Skills](https://cursor.com/docs/skills.md), and [CLI rule support](https://cursor.com/docs/cli/using.md).
- **Supported OSes:** project paths are platform-independent. Confirmed user skill roots are resolved through the supplied home directory on Cursor editor/CLI platforms. Cursor user rules are settings-managed rather than documented at a stable readable filesystem path and are not scanned.
- **Project rules and instructions:** recursive `.cursor/rules/**/*.mdc`, root `AGENTS.md`, root `CLAUDE.md`, and deprecated root `.cursorrules`. Plain `.md` files under `.cursor/rules` are ignored as Cursor requires `.mdc`. YAML rule metadata such as `description`, `globs`, and `alwaysApply` survives normalization; Ruleloom has no target-file input and does not evaluate applicability. Nested `AGENTS.md` files outside the supplied endpoints are not broadly crawled.
- **Project and user skills:** `.cursor/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`, and Cursor's documented Claude/Codex compatibility roots `.claude/skills/<name>/SKILL.md` and `.codex/skills/<name>/SKILL.md`. The same four roots under the supplied home directory are included when global discovery is enabled. Nested category folders inside each exact skill root are scanned within fixed depth.
- **Ordering and precedence:** existing Ruleloom precedence is unchanged: repository 100, workspace 80, explicit 70, global 40, system 10. Canonical-realpath dedupe and static source order remain deterministic, and every documented/explicit source is forcibly attributed to `cursor`. Ruleloom stores sources independently and does not claim Cursor's final rule ordering, selection, enabled state, or effective prompt.
- **Bounds and path policy:** every exact source root uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Every artifact must remain inside its individual source root and allowed roots. Symlinks, escapes, inaccessible entries, hidden nested directories, `node_modules`, cache/dependency trees, and unsupported file extensions are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Cursor settings or runtime state.
- **Fallback and diagnostics:** absent, limited, unsafe, or inaccessible optional roots are non-fatal `discoveryDiagnostics`. Unsupported settings/runtime sources emit `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with exact `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** current official docs describe workspace/user commands and settings-managed user/team rules but do not provide a stable portable readable filesystem contract for them, so `.cursor/commands`, user rules, team rules, and private editor storage are not scanned. Ruleloom does not inspect plugins, imported remote rules, dashboard state, profile exports, caches, settings payloads, enabled/disabled state, runtime context, session transcripts, or final prompts. Add each trusted readable unsupported directory through explicit roots.

## Agent environment contract: Gemini CLI

- **sourceSystem / capability:** canonical public ID `gemini`; documented workspace/user skill roots, the documented `GEMINI.md` hierarchy, documented installed-extension skill roots, and explicit roots. Runtime/config-effective discovery is not shipped.
- **Verified owner, version, and date:** Google (`google-gemini/gemini-cli`), verified 2026-07-15 against latest stable Gemini CLI v0.50.0 (released 2026-07-08) and official documentation available 2026-07-15. The web documentation is continuously updated rather than release-versioned, so later releases require re-verification. The official site also announces migration of unpaid-tier and Google One users to Antigravity CLI; this contract does not claim Antigravity compatibility.
- **Evidence:** [latest stable v0.50.0](https://geminicli.com/docs/changelogs/latest/), [Agent Skills](https://geminicli.com/docs/cli/skills/), [GEMINI.md context](https://geminicli.com/docs/cli/gemini-md/), [extension reference](https://geminicli.com/docs/extensions/reference/), and [extension authoring](https://geminicli.com/docs/extensions/writing-extensions/). On verification, those pages were last updated 2026-07-08, 2026-04-30, 2026-06-18, and 2026-05-14 respectively.
- **Supported OSes:** documented workspace paths are platform-independent. User and installed-extension paths are resolved from the supplied home directory on Gemini CLI platforms; no platform cache or package location is scanned.
- **Workspace sources:** `.gemini/skills/<name>/SKILL.md` and the `.agents/skills/<name>/SKILL.md` alias at each supplied repository-to-workspace endpoint. `GEMINI.md` is collected root-to-workspace along that supplied hierarchy. Ruleloom does not perform Gemini CLI's just-in-time descendant scan because no tool-accessed path is available at index time.
- **Global sources:** `~/.gemini/skills/<name>/SKILL.md`, `~/.agents/skills/<name>/SKILL.md`, and `~/.gemini/GEMINI.md` when global discovery is enabled.
- **Extension sources:** the official extension reference documents installed extensions at `~/.gemini/extensions/<extension>/` and skills at each extension's `skills/` directory. Ruleloom enumerates only direct extension children with a regular `gemini-extension.json`, then scans that exact `skills/` root. It does not recurse for extensions, enumerate caches, inspect package trees, or parse extension settings.
- **Ordering and precedence:** Gemini CLI documents built-in < extension < user < workspace precedence and `.agents/skills` above `.gemini/skills` within user/workspace tiers. Ruleloom does not index built-ins. Installed-extension skills use 20; user `.gemini` uses 40 and user `.agents` 41; existing explicit roots remain 70; repository/workspace precedence remains 100/80 with `.agents` one point above the matching `.gemini` tier. Canonical-realpath dedupe and static source order remain deterministic. Every adapter and explicit artifact is forcibly attributed to `gemini`.
- **Bounds and path policy:** every skill source uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Extension enumeration is direct and capped at 10,000 entries and 500 total extension artifacts. Every artifact must remain inside its individual source root and allowed roots. Symlinks, escapes, inaccessible entries, hidden nested directories, `node_modules`, cache/dependency trees, and extension entries without a regular manifest are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Gemini CLI state and does not invoke Gemini CLI.
- **Fallback and diagnostics:** absent, limited, unsafe, or inaccessible optional sources are non-fatal `discoveryDiagnostics`. Unsupported effective configuration/runtime state emits `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with exact `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** `/skills list` and `gemini skills list` are documented management displays, but no stable machine-readable effective-source integration was documented and tested for this unit. Ruleloom therefore does not invoke them or reconstruct enabled/disabled state, linked skill sources, built-in skills, runtime metadata, final prompts, session state, imported `GEMINI.md` files, configured `context.fileName`, configured workspace directories beyond supplied roots, or JIT context. Linked extensions are symlinks and are rejected by Ruleloom's stricter containment policy; pass a trusted real skill directory explicitly when needed. Extension `GEMINI.md` context is not an extension skill and is outside this adapter unit.

## Agent environment contract: Windsurf / Devin Desktop

- **sourceSystem / capability:** canonical public ID `windsurf`; documented Devin Desktop workspace rules, `AGENTS.md` hierarchy, legacy Windsurf compatibility rules, the documented global-rules file, and explicit roots. Runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Cognition, verified 2026-07-15 against the current Devin Desktop contract. Windsurf became Devin Desktop on 2026-06-02; Windsurf 2.0 users were already on the product that became Devin Desktop. Cognition documents latest-release support rather than a stable numeric filesystem-contract version, so this adapter targets the latest current desktop release and requires re-verification after contract changes.
- **Evidence:** [Devin Desktop FAQ](https://docs.devin.ai/desktop/devin-desktop-faq), [Memories & Rules](https://docs.devin.ai/desktop/cascade/memories), [AGENTS.md](https://docs.devin.ai/desktop/cascade/agents-md), and the dated [Windsurf is now Devin Desktop announcement](https://windsurf.com/blog/windsurf-is-now-devin-desktop). The FAQ explicitly says previous releases other than latest are deprecated.
- **Current versus legacy paths:** current workspace rules are `.devin/rules/**/*.md`; `.windsurf/rules/**/*.md` is a documented fallback only when the matching current rule root yields no rules. Root `.windsurfrules` remains a documented legacy single-file input and has no `.devinrules` equivalent. The global rule remains at the explicitly documented, unchanged legacy-named path `~/.codeium/windsurf/memories/global_rules.md`; this is a current supported path, not a crawl of generated memories. New per-user IDE/config data uses Devin-named application directories, but those private/state directories are not rule roots and are not scanned.
- **Workspace and AGENTS hierarchy:** every supplied workspace/repository ancestor endpoint and workspace descendant through the fixed depth contributes current-or-fallback rule roots. `AGENTS.md` and `agents.md` are discovered root-to-descendant; root instructions are always-on in the host and descendant files are directory-scoped. Ruleloom preserves that deterministic hierarchy but stores files independently rather than evaluating target-file activation.
- **Global source:** only `~/.codeium/windsurf/memories/global_rules.md` is read when globals are enabled. Other files under `memories/` are workspace-associated auto-generated memory/private state and are never enumerated.
- **Ordering and precedence:** existing Ruleloom tiers remain repository 100, workspace 80, explicit 70, global 40, system 10. Within a workspace tier, deeper hierarchy entries receive a bounded depth offset; current `.devin/rules` receives +2 and fallback `.windsurf/rules` +1, so current rules deterministically win same-name conflicts. The legacy `.windsurfrules` file receives no offset. Canonical-realpath dedupe and static source order remain deterministic, and every adapter/explicit artifact is forcibly attributed to `windsurf`.
- **Bounds and path policy:** source scans retain the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth limits. Workspace source-location traversal is capped at 10,000 entries and depth 5. Symlinks, escapes, inaccessible/oversized/overlong entries, hidden/generated directories, caches, dependencies, and private application state are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Devin Desktop/Windsurf state and invokes no host process.
- **Fallback and diagnostics:** absent, limited, inaccessible, unsafe, and truncated optional roots are non-fatal bounded `discoveryDiagnostics`. Unsupported activation/runtime/private/system sources emit `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with exact `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom does not evaluate `trigger`, `globs`, manual/model-decision activation, current files, or runtime-selected context and does not reconstruct final/system prompts. It does not crawl auto-generated memories, caches, `globalStorage`, extension/private state, settings, sessions, transcripts, model requests, or package trees. Enterprise system rules are administrator-managed and can be inaccessible; this adapter deliberately does not read Devin- or Windsurf-named system directories. Add each trusted readable unsupported directory through explicit roots.

## Agent environment contract: Cline

- **sourceSystem / capability:** canonical public ID `cline`; confirmed local workspace/user rules, documented compatibility instructions and skills, and explicit roots. Runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Cline Bot Inc. (`cline/cline`), verified 2026-07-15 against the latest stable VS Code extension v4.0.8 (released 2026-07-11), latest stable CLI v3.0.40 (released 2026-07-13), the tagged v4.0.8 official source, and official documentation available 2026-07-15. Cline's web docs and `main` branch are continuously updated; version-specific behavior must be re-verified after changes.
- **Evidence:** [VS Code v4.0.8 release](https://github.com/cline/cline/releases/tag/v4.0.8), [CLI v3.0.40 release](https://github.com/cline/cline/releases/tag/cli-v3.0.40), [Rules](https://docs.cline.bot/customization/cline-rules), [Config/storage locations](https://docs.cline.bot/getting-started/config), [Skills](https://docs.cline.bot/customization/skills), [Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act), and the [tagged v4.0.8 rule loader](https://github.com/cline/cline/blob/v4.0.8/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts). The current docs call `.clinerules/` primary while current config docs/source also call `.cline/rules` the project config root; both are retained explicitly rather than treating that evolving naming as one stable alias.
- **Supported OSes and global caveat:** workspace paths are platform-independent. With global discovery enabled, `~/.cline/rules`, `~/.cline/skills`, `~/.agents/AGENTS.md`, and `~/Documents/Cline/Rules` are resolved from the supplied home directory. Official Rules docs call `Documents/Cline/Rules` the default global Rules location while Config docs call it an additional compatibility path; both are supported, but that global documentation is not fully stable. The documented Linux/WSL `~/Cline/Rules` fallback is included only on Linux. Custom `CLINE_DATA_DIR`, `--data-dir`, and `--config` locations cannot be inferred from this API and require explicit roots.
- **Workspace rules and custom instructions:** a root `.clinerules` regular file is retained for official legacy compatibility. A `.clinerules/` directory contributes recursive `.md` and `.txt` rules, excluding its `hooks`, `skills`, and `workflows` subtrees. Current `.cline/rules/**/*.md|*.txt`, root `AGENTS.md`, `.cursorrules`, and `.windsurfrules` are also indexed. Current Cline migrated UI custom instructions into rule files; Ruleloom reads those durable files but never private UI/settings state.
- **Skills:** project `.cline/skills`, legacy `.clinerules/skills`, and documented Claude-compatible `.claude/skills` are scanned, plus global `~/.cline/skills` when enabled. Each requires a bounded skill directory containing `SKILL.md`.
- **Modes and ordering:** official Plan and Act modes change tool permissions/behavior and may use different models, but no separate stable readable mode-specific instruction root is documented. Common rule files are retained without guessing an active mode. Existing Ruleloom precedence remains repository 100, workspace 80, explicit 70, global 40, system 10; current `.cline/rules` receives a one-point preference over same-tier legacy `.clinerules`. Canonical-realpath dedupe and static source order remain deterministic, and every adapter/explicit artifact is forcibly attributed to `cline`.
- **Bounds and path policy:** each exact source uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Every file must be regular, non-symlink, and contained by its source and allowed roots. Symlinks, escapes, inaccessible/oversized/overlong entries, hidden nested directories, `node_modules`, caches, dependency trees, settings payloads, and unsupported extensions are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Cline state and does not invoke Cline.
- **Fallback and diagnostics:** absent, unsafe, inaccessible, and truncated optional sources are non-fatal bounded `discoveryDiagnostics`. Stable `.cline` configuration roots report configuration use. A separate `SOURCE_UNSUPPORTED` diagnostic records unavailable mode/toggle/private/runtime state with exact `index_skills.roots` guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom does not read `~/.cline/data/settings` (which may contain provider credentials), private extension storage, remote/team rules, enabled/disabled toggles, plugins, hooks, workflows, cron, agents, sessions, databases, settings payloads, imported state, current tabs/files used by conditional-rule evaluation, active Plan/Act mode, model selection, runtime-selected skills, transcripts, model requests, or final/effective prompts. Conditional frontmatter is preserved but not evaluated because indexing has no runtime file context. Add each trusted readable custom root explicitly.

## Agent environment contract: Roo Code

- **sourceSystem / capability:** canonical public ID `roo`; confirmed global/workspace generic and mode-specific rule and skill roots, workspace legacy fallback files, root agent instructions, the stable `roo-cline.useAgentRules` VS Code setting, and explicit roots. Runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Roo Code, Inc. (`RooCodeInc/Roo-Code`), verified 2026-07-15 against final official release v3.54.0 (published 2026-05-15), the final Marketplace extension `RooVeterinaryInc.roo-cline` v3.54.0, and official documentation last updated 2026-05-15. The Marketplace states that the extension was shut down on 2026-05-15; this compatibility record is intentionally pinned to the final official release and does not claim compatibility with community forks.
- **Evidence:** [v3.54.0 release](https://github.com/RooCodeInc/Roo-Code/releases/tag/v3.54.0), [Marketplace v3.54.0 record](https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline), [Custom Instructions](https://docs.roocode.com/features/custom-instructions), [Skills](https://docs.roocode.com/features/skills), [Custom Modes](https://docs.roocode.com/features/custom-modes), [Roo settings reference](https://docs.roocode.com/features/settings-management), and [VS Code settings locations and precedence](https://code.visualstudio.com/docs/configure/settings).
- **Supported OSes:** rule and skill roots are platform-independent. `~` is resolved from the supplied home directory. The default VS Code user `settings.json` path follows the documented Windows, macOS, or Linux location; workspace settings use `.vscode/settings.json`. Profile, remote, multi-root workspace-file, and policy settings are not resolved because no active VS Code workspace/profile identity is supplied.
- **Rules:** generic files are read recursively from `~/.roo/rules/` and each supplied workspace/repository `.roo/rules/`. Every direct `rules-{modeSlug}` directory under the same `.roo` roots is retained without guessing which mode is active. Mode-specific sources receive a deterministic one-point preference over the matching generic tier. Workspace `.roorules` and `.roorules-{modeSlug}` are fallback files only when the corresponding global/workspace directories yielded no artifacts. Deprecated `.clinerules` compatibility is not included in this Roo-only unit.
- **Skills:** generic and every direct mode-specific root are scanned at global and supplied project levels: `.roo/skills`, `.roo/skills-{modeSlug}`, `.agents/skills`, and `.agents/skills-{modeSlug}`. Within a project/global tier the confirmed host order is represented by offsets `.roo` mode-specific +4, `.roo` generic +3, `.agents` mode-specific +2, and `.agents` generic +1. Project tiers still outrank global tiers.
- **Agent instructions and stable settings:** root `AGENTS.md` is preferred over root `AGENT.md`. The adapter reads only the boolean `roo-cline.useAgentRules` from bounded, regular, contained default VS Code user/workspace `settings.json` files; a workspace value overrides the default user value. Settings files are never indexed or emitted. The documented default is used when neither file supplies the key.
- **Ordering and precedence:** existing base precedence remains repository 100, workspace 80, explicit 70, global 40, system 10, with the narrow Roo offsets above. Canonical-realpath dedupe and static source ordering remain deterministic. Every adapter and explicit artifact is forcibly attributed to `roo`. Sources are retained independently; Ruleloom does not claim Roo Code's final prompt assembly order.
- **Bounds and path policy:** each exact source root uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Direct mode-root enumeration is independently capped at 10,000 entries. Every artifact and settings file must be a regular, non-symlink path contained by its supplied source and allowed roots. Symlinks, escapes, inaccessible or oversized entries, hidden nested directories, `node_modules`, caches, dependencies, and private extension storage are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Roo Code or VS Code state.
- **Fallback and diagnostics:** absent, invalid, limited, unsafe, inaccessible, and truncated optional sources are non-fatal bounded `discoveryDiagnostics`. Stable setting use reports `SOURCE_USED`; absent/invalid settings are diagnosed without payloads. Unsupported active/runtime state reports `configuration` / `configuration` / `SOURCE_UNSUPPORTED` with exact explicit-root guidance. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** no active mode is inferred, so all present mode-specific roots remain explicit candidates. Ruleloom does not inspect UI custom instructions, language preference, `.roomodes` mode `customInstructions`, global mode configuration, automatic settings-import payloads, custom/private extension storage, API profiles or keys, profiles, Settings Sync, remote or policy settings, task history, checkpoints, `.rooignore`, commands, MCP state, enabled/disabled skill state, runtime-selected skills, prompts, transcripts, model requests, or final prompts. Add each trusted readable unsupported root explicitly. Community successors and forks require separate IDs/contracts and are outside this unit.

## Agent environment contract: Continue

- **sourceSystem / capability:** canonical public ID `continue`; confirmed workspace Markdown rules, bounded active user-config references to local Markdown rules/prompts, and explicit roots. Runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Continue (`continuedev/continue`), verified 2026-07-15 against latest stable VS Code release `v2.0.0-vscode` (published 2026-06-19), current config schema `v1`, and official documentation available 2026-07-15. Continue's web documentation and `main` branch are continuously updated rather than release-versioned, so later releases or schema changes require re-verification.
- **Evidence:** [v2.0.0-vscode](https://github.com/continuedev/continue/releases/tag/v2.0.0-vscode), [Rules](https://docs.continue.dev/customize/deep-dives/rules), [Prompts](https://docs.continue.dev/customize/deep-dives/prompts), [Configuration](https://docs.continue.dev/customize/deep-dives/configuration), [config.yaml schema v1 reference](https://docs.continue.dev/reference), and [YAML migration/active-file precedence](https://docs.continue.dev/reference/yaml-migration).
- **Supported OSes:** workspace rule paths are platform-independent. The documented user config is resolved from the supplied home directory as `~/.continue/config.yaml` on macOS/Linux and `%USERPROFILE%\.continue\config.yaml` on Windows. The same-directory deprecated `config.json` is considered only when `config.yaml` is absent, matching Continue's documented active-file precedence.
- **Workspace rules:** recursive `.continue/rules/**/*.md` files under each supplied workspace/repository endpoint. Continue recommends Markdown and uses YAML frontmatter for properties including `name`, `globs`, `regex`, `description`, and `alwaysApply`; Ruleloom preserves that frontmatter but has no target-file input and does not evaluate applicability. Lexicographic filenames remain deterministic, but sources are stored independently rather than composed.
- **User config rules and prompts:** the active bounded regular config file is parsed only to locate top-level `rules` and `prompts` entries whose `uses` value is a canonical local `file://` URL ending in `.md` or `.markdown`. Referenced rules become `rule_file` artifacts and referenced prompts become `instruction_file` artifacts because both are durable Markdown Ruleloom inputs. Inline strings/objects, remote Hub references, and other config fields are never emitted, preventing model credentials and unrelated settings from entering the index. At most 100 references are considered.
- **Ordering and precedence:** existing Ruleloom precedence remains repository 100, workspace 80, explicit 70, global 40, system 10, with canonical-realpath dedupe and static source order. Every adapter and explicit artifact is forcibly attributed to `continue`. Ruleloom does not claim Continue's toolbar order or composed system-message order.
- **Bounds and path policy:** each workspace rule root and referenced file uses the shared 10,000-entry, 500-artifact, 1 MiB-file, 4,096-byte-path, and depth bounds. Config parsing uses the same file/path limits and a 100-reference cap. Every file must be regular, non-symlink, and contained by its individual source and allowed roots. Unsafe, inaccessible, oversized, overlong, non-Markdown, remote, cache, dependency-tree, and `node_modules` entries are skipped.
- **Lifecycle/invalidation/cleanup:** current files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Continue configuration, state, or handoff.
- **Fallback and diagnostics:** absent roots/config, malformed or unsupported-schema config, skipped config entries, and unsafe/inaccessible sources are non-fatal bounded `discoveryDiagnostics`; malformed config emits `SOURCE_INVALID`. A separate `SOURCE_UNSUPPORTED` limitation records unobservable runtime composition. Every diagnostic gives exact `index_skills.roots` guidance without paths or payloads. Explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom does not index whole config files, inline rule/prompt text, non-Markdown prompt formats, remote/Hub blocks, secrets, models, tools, deprecated `config.ts` or `.continuerc.json`, organization state, private extension storage, caches, session state, toolbar-selected/current rules, base system messages, runtime applicability, or the composed/final system message. No stable readable user/global rule directory beyond the active documented config was confirmed. Add each trusted readable unsupported local directory through explicit roots.

## Agent environment contract: Aider

- **sourceSystem / capability:** canonical public ID `aider`; bounded supported `.aider.conf.yml` `read` configuration plus explicit roots. Aider has no native skills directory, and runtime-effective discovery is not shipped.
- **Verified owner, version, and date:** Aider (`Aider-AI/aider`), verified 2026-07-18 against the current latest stable `aider-chat` v0.86.0 (published 2025-08-09), its tagged source, and official documentation available 2026-07-18. The web documentation is continuously updated rather than release-versioned, so a later release or configuration change requires re-verification.
- **Evidence:** [latest v0.86.0 release](https://github.com/Aider-AI/aider/releases/tag/v0.86.0), [PyPI v0.86.0 record](https://pypi.org/project/aider-chat/0.86.0/), [YAML config locations, precedence, and list forms](https://aider.chat/docs/config/aider_conf.html), [`--read` and `--config` option reference](https://aider.chat/docs/config/options.html#--read-file), [coding conventions and persistent `read:` examples](https://aider.chat/docs/usage/conventions.html), and [tagged v0.86.0 config search/read handling](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/main.py).
- **Supported locations and OSes:** Aider documents `.aider.conf.yml` in the home directory, Git repository root, and current directory, loaded in that order with later files taking priority. Ruleloom maps those to the supplied home, `repoRoot` when available, and supplied workspace/base directory, deduping identical locations. Paths are platform-independent and `~` uses the supplied home directory.
- **Configuration inputs:** only top-level `read` as one string or a YAML list of strings is consumed. The config itself is never indexed. Relative references are resolved from the supplied workspace/current-directory endpoint, matching Aider v0.86.0's `Path(...).expanduser().resolve()` handling after config parsing; `~/` references use the supplied home. Referenced regular files become `instruction_file` artifacts, with convention/style-named files classified as `convention_file`. Files are indexed only when explicitly configured; no conventional filename is inferred.
- **Ordering and precedence:** Aider's documented config order is home, repository, then current directory, with the highest-priority config that defines `read` overriding lower config values. Ruleloom mirrors that effective `read` selection, then applies existing source tiers: repository 100, workspace/current-directory 80, explicit 70, global/home 40, system 10. Canonical-realpath dedupe keeps the highest tier, then static source order. Every adapter and explicit artifact is forcibly attributed to `aider`. Ruleloom stores files independently rather than reconstructing Aider's final prompt order.
- **Bounds and path policy:** config files and referenced files use the shared 1 MiB-file and 4,096-byte-path limits; at most 100 `read` references and 500 resulting artifacts are retained. Configs and references must be regular, non-symlink paths contained by their individual source and allowed supplied roots. Missing, malformed, overlong, oversized, inaccessible, symlinked, escaping, directory, and over-limit references are skipped without reading contents. No cache, package tree, home-directory crawl, or dependency directory is enumerated.
- **Lifecycle/invalidation/cleanup:** current supported configs and referenced files are read on each index operation and enter the existing normalize, compile, store, stale-pruning, and atomic live-index pipeline. The adapter writes no Aider config, history, state, or handoff.
- **Fallback and diagnostics:** absent/malformed/unsafe configs and absent/malformed/unsafe/inaccessible/truncated references produce bounded non-fatal `discoveryDiagnostics` with no raw path or payload. No-native-root and unavailable runtime inputs produce `SOURCE_UNSUPPORTED`. Every diagnostic provides exact `index_skills.roots` guidance; explicit-root request-boundary failures remain fatal.
- **Limitations / unsupported behavior:** Ruleloom cannot observe Aider's process arguments, so `--config`, command-line/environment `--read`, positional files, and the actual Aider cwd are unavailable unless represented by the supplied Ruleloom inputs. It does not infer session `/read` or `/drop` state, recursively import configured directories, run Aider, inspect chat/history/cache/repo-map state, parse `/load` command files, or reconstruct model/system/final prompts. Arbitrary convention filenames are not guessed. Supply the same workspace/base directory as Aider and pass each trusted unsupported source directory through explicit roots.

## Compile Conflicts Are Non-Fatal Diagnostics

When the compiler detects precedence conflicts between skill sources (e.g.,
two systems define the same skill name, or sections collide), these are
reported as `SkillConflictDiagnostic` entries in `CompileResult.diagnostics`,
**not** as `BoundaryError` entries in `CompileResult.errors`.

- A conflict does not prevent compilation; the compiler picks a winner by
  precedence (or deterministic tiebreak) and records the decision.
- `errors` remains reserved for hard failures (unreadable files, parse
  errors, unsafe paths).
- Consumers that need to surface conflicts to users read `diagnostics`, not
  `errors`.

**Migration responsibility (Track B):** If the current runtime still emits
conflicts as `BoundaryError` entries in `errors`, Track B must migrate
conflict reporting to `diagnostics` before claiming contract compliance.
This contract defines the target state; runtime parity is a Track B deliverable.

## Freezing Rules

1. A type or module signature in this document may not be altered by a
   single change.
2. Changes require updating this contract first, then updating dependents.
