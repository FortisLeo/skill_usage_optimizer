export type SourceSystem = 'claude' | 'opencode' | 'codex' | 'copilot';

export type SectionClass = 'always' | 'phase' | 'on_demand' | 'reference';

export type ArtifactKind =
  | 'skill_package'
  | 'instruction_file'
  | 'rule_file'
  | 'convention_file'
  | 'pseudo_skill';

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

export interface DiscoveryContext {
  workspaceRoot: string;
  repoRoot: string | null;
  /** Broad normalization boundary for global artifacts (only active when includeGlobals is true). */
  homeDir: string;
  includeGlobals: boolean;
  includeSystem: boolean;
  explicitRoots: string[];
  /** Attribute arbitrary explicit roots to this system; heuristic fallback still applies when absent. */
  explicitRootSystem?: SourceSystem;
  /** Test seam: override the Codex system skills directory. Defaults to /etc/codex/skills. */
  codexSystemRoot?: string;
}

export interface DiscoveredArtifact {
  system: SourceSystem;
  kind: ArtifactKind;
  absolutePath: string;
  relativePath: string;
  rootOrigin: string;
  precedence: number;
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

export interface RetrievalRequest {
  query?: string;
  phase?: string;
  includeReferences?: boolean;
  maxBytes?: number;
}

export interface OmittedItem {
  id: string;
  reason: 'budget' | 'no_match' | 'reference_unresolved';
}

export type BoundaryError = { path: string; error: string };

// --- Result types ---

export interface DiscoverResult {
  artifacts: DiscoveredArtifact[];
  errors: BoundaryError[];
}

export interface NormalizeResult {
  inputs: NormalizedSkillInput[];
  errors: BoundaryError[];
}

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
}

export type SkillStore = Map<string, SkillSection> | Record<string, SkillSection>;

export interface RetrievalBundle {
  sections: SkillSection[];
  context: string;
  references?: LoadedReference[];
  omitted?: OmittedItem[];
  totalBytes?: number;
}

export interface CompileResult {
  store: SkillStore;
  errors: BoundaryError[];
  manifests?: SkillManifest[];
  diagnostics?: SkillConflictDiagnostic[];
}
