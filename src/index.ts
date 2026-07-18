#!/usr/bin/env node
export { discover } from './discovery/index.js';
export { normalize } from './normalize/index.js';
export { compile } from './compiler/index.js';
export { loadContext } from './retrieval/context.js';
export { doctor, MAX_SECTION_TOKENS } from './resolver/doctor.js';
export { FileStore } from './store/fileStore.js';
export { SOURCE_SYSTEMS } from './types.js';
export type { ToolDeps } from './mcp/tools.js';
export type { McpServerOptions } from './mcp/server.js';

export type {
  ArtifactKind,
  BoundaryError,
  DiscoveredArtifact,
  DiscoveryDiagnostic,
  DiscoveryContext,
  DiscoverResult,
  CompileResult,
  LoadedReference,
  MandatoryPolicy,
  ManifestSectionRef,
  NormalizedSkillInput,
  NormalizeResult,
  OmittedItem,
  ReferenceRef,
  RelatedEdge,
  FlowNode,
  ResolveRequest,
  ResolvedSection,
  ResolveResult,
  RetrievalBundle,
  RetrievalRequest,
  SectionClass,
  SkillManifest,
  SkillSection,
  SkillStore,
  SourceSystem
} from './types.js';

// Start the MCP server when run directly
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { startMcpServer as _startMcpServer } from './mcp/server.js';
export { _startMcpServer as startMcpServer };

const isMain = process.argv[1] != null && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  _startMcpServer().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
