// ponytail: thin stdio MCP server delegating to pure handlers
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { discover } from '../discovery/index.js';
import { normalize } from '../normalize/index.js';
import { compile } from '../compiler/index.js';
import { loadContext } from '../retrieval/context.js';
import { searchSections } from '../search/lexical.js';
import { resolve as resolveTask } from '../resolver/index.js';
import { FileStore } from '../store/fileStore.js';
import type { ToolDeps } from './tools.js';
import {
  handleIndexSkills,
  handleListSkills,
  handleGetSkillManifest,
  handleGetSkillSections,
  handleLoadSkillContext,
  handleLoadSection,
  handleSearchSkillSections,
  handleResolveTaskSections,
  handleGetTokenSavingsStats,
  handleDoctor,
  handleDiscoverSkillFolders
} from './tools.js';
import {
  validateIndexSkillsArgs,
  validateListSkillsArgs,
  validateGetSkillManifestArgs,
  validateGetSkillSectionsArgs,
  validateLoadSkillContextArgs,
  validateLoadSectionArgs, validateSearchSkillSectionsArgs, validateResolveTaskSectionsArgs, validateTokenSavingsStatsArgs, validateDoctorArgs, validateDiscoverSkillFoldersArgs
} from './schemas.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SOURCE_SYSTEMS } from '../types.js';

export const TOOL_DEFS = [
  {
    name: 'discover_skill_folders',
    description: 'Opt-in bounded discovery of known roots and literal lowercase skills directories under the project root, or home when scope is explicitly home. Does not read or index skill content.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['project', 'home'] }, maxDepth: { type: 'integer', minimum: 0, maximum: 10 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } }
  },
  {
    name: 'index_skills',
    description: 'Discover, normalize, and compile skills from a source system into the local cache. Returns response-only discoveryDiagnostics for non-fatal source limitations; compiler conflicts remain in diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', enum: [...SOURCE_SYSTEMS] },
        roots: { type: 'array', items: { type: 'string' } },
        baseDir: { type: 'string' },
        force: { type: 'boolean' }
      },
      required: ['system']
    }
  },
  {
    name: 'list_skills',
    description: 'List all indexed skills.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', enum: [...SOURCE_SYSTEMS] }
      }
    }
  },
  {
    name: 'get_skill_manifest',
    description: 'Get manifest for a specific skill by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' }
      },
      required: ['skillId']
    }
  },
  {
    name: 'get_skill_sections',
    description: 'Get sections for a specific skill by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' }
      },
      required: ['skillId']
    }
  },
  {
    name: 'load_skill_context',
    description: 'Load skill context for a query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        phase: { type: 'string' },
        includeReferences: { type: 'boolean' },
        maxBytes: { type: 'number' }
      }
    }
  },
  {
    name: 'load_section',
    description: 'Load a single section by ID and detect duplicate references.',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: { type: 'string' }
      },
      required: ['sectionId']
    }
  },
  {
    name: 'search_skill_sections',
    description: 'Search indexed sections. With phase, deliberately AND-filters to phase-class sections that lexically match the phase, then ranks by query; this differs from load_skill_context.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, phase: { type: 'string' }, skill: { type: 'string' }, k: { type: 'integer', minimum: 1 } }, required: ['query'] }
  },
  {
    name: 'resolve_task_sections',
    description: 'Resolve task sections and dependencies. With phase, deliberately AND-filters to phase-class sections that lexically match the phase, then resolves by query; this differs from load_skill_context.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, phase: { type: 'string' }, skill: { type: 'string' }, budget: { type: 'number', exclusiveMinimum: 0 }, includeSoft: { type: 'boolean' }, sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, newSession: { type: 'boolean' } }, required: ['query'] }
  },
  {
    name: 'get_token_savings_stats',
    description: 'Return local Ruleloom estimated token proxy totals. No provider, billing, or cost data is used.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, newSession: { type: 'boolean' } } }
  },
  {
    name: 'doctor',
    description: 'Check optimizer health without changing the index.',
    inputSchema: { type: 'object', properties: {} }
  }
];

export interface McpServerOptions {
  storeDir?: string;
  homeDir?: string;
  workspaceRoot?: string;
}

export async function createToolDeps(opts: McpServerOptions = {}): Promise<ToolDeps> {
  const storeDir = opts.storeDir ?? resolve(process.cwd(), '.skill-cache');
  const homeDir = opts.homeDir ?? homedir();
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();

  const fileStore = new FileStore(storeDir);
  await fileStore.init();

  return {
    discover,
    normalize,
    // ponytail: adapter — compiler returns Map|Record union, handler expects Map
    compile: (inputs, ctx) => {
      const result = compile(inputs, ctx);
      return {
        store: result.store instanceof Map ? result.store : new Map(Object.entries(result.store)),
        errors: result.errors,
        manifests: result.manifests,
        diagnostics: result.diagnostics
      };
    },
      loadContext,
      searchSections,
      resolve: resolveTask,
    store: fileStore,
    resolveHomeDir: () => homeDir,
    resolveWorkspaceRoot: () => workspaceRoot
  };
}

export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const deps = await createToolDeps(opts);

  const server = new Server(
    { name: 'skill-usage-optimizer', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'discover_skill_folders': {
          const v = validateDiscoverSkillFoldersArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          return { content: [{ type: 'text', text: await handleDiscoverSkillFolders(deps, v.value.scope, v.value.maxDepth, v.value.limit) }] };
        }
        case 'index_skills': {
          const v = validateIndexSkillsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleIndexSkills(deps, v.value.system, v.value.roots, v.value.baseDir, v.value.force);
          return { content: [{ type: 'text', text }] };
        }
        case 'list_skills': {
          const v = validateListSkillsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleListSkills(deps, v.value.system);
          return { content: [{ type: 'text', text }] };
        }
        case 'get_skill_manifest': {
          const v = validateGetSkillManifestArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleGetSkillManifest(deps, v.value.skillId);
          return { content: [{ type: 'text', text }] };
        }
        case 'get_skill_sections': {
          const v = validateGetSkillSectionsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleGetSkillSections(deps, v.value.skillId);
          return { content: [{ type: 'text', text }] };
        }
        case 'load_skill_context': {
          const v = validateLoadSkillContextArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleLoadSkillContext(deps, v.value.query, v.value.phase, v.value.includeReferences, v.value.maxBytes);
          return { content: [{ type: 'text', text }] };
        }
        case 'load_section': {
          const v = validateLoadSectionArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleLoadSection(deps, v.value.sectionId);
          return { content: [{ type: 'text', text }] };
        }
        case 'search_skill_sections': {
          const v = validateSearchSkillSectionsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleSearchSkillSections(deps, v.value.query, v.value.phase, v.value.skill, v.value.k);
          const parsed = JSON.parse(text);
          return { content: [{ type: 'text', text }], ...(parsed.errors ? { isError: true } : {}) };
        }
        case 'resolve_task_sections': {
          const v = validateResolveTaskSectionsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleResolveTaskSections(deps, v.value.query, v.value.phase, v.value.skill, v.value.budget, v.value.includeSoft, v.value.sessionId, v.value.newSession);
          const parsed = JSON.parse(text);
          return { content: [{ type: 'text', text }], ...(parsed.errors ? { isError: true } : {}) };
        }
        case 'get_token_savings_stats': {
          const v = validateTokenSavingsStatsArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
          const text = await handleGetTokenSavingsStats(deps, v.value.sessionId, v.value.newSession);
          return { content: [{ type: 'text', text }], ...(JSON.parse(text).errors ? { isError: true } : {}) };
        }
        case 'doctor': {
          const v = validateDoctorArgs(args ?? {});
          if (!v.ok) return { content: [{ type: 'text', text: JSON.stringify({ errors: v.errors }) }], isError: true };
           return { content: [{ type: 'text', text: await handleDoctor(deps) }] };
        }
        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ errors: [`unknown tool: ${name}`] }) }],
            isError: true
          };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ errors: [err instanceof Error ? err.message : String(err)] }) }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function handleMcpToolCall(deps: ToolDeps, name: string, args: unknown = {}): Promise<any> {
  const error = (errors: string[]) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ errors }) }], isError: true });
  try {
    if (name === 'discover_skill_folders') {
      const v = validateDiscoverSkillFoldersArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleDiscoverSkillFolders(deps, v.value.scope, v.value.maxDepth, v.value.limit) }] };
    }
    if (name === 'index_skills') {
      const v = validateIndexSkillsArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleIndexSkills(deps, v.value.system, v.value.roots, v.value.baseDir, v.value.force) }] };
    }
    if (name === 'list_skills') {
      const v = validateListSkillsArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleListSkills(deps, v.value.system) }] };
    }
    if (name === 'get_skill_manifest') {
      const v = validateGetSkillManifestArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleGetSkillManifest(deps, v.value.skillId) }] };
    }
    if (name === 'get_skill_sections') {
      const v = validateGetSkillSectionsArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleGetSkillSections(deps, v.value.skillId) }] };
    }
    if (name === 'load_skill_context') {
      const v = validateLoadSkillContextArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleLoadSkillContext(deps, v.value.query, v.value.phase, v.value.includeReferences, v.value.maxBytes) }] };
    }
    if (name === 'load_section') {
      const v = validateLoadSectionArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleLoadSection(deps, v.value.sectionId) }] };
    }
    if (name === 'search_skill_sections') {
      const v = validateSearchSkillSectionsArgs(args);
      if (!v.ok) return error(v.errors);
      const text = await handleSearchSkillSections(deps, v.value.query, v.value.phase, v.value.skill, v.value.k);
      const parsed = JSON.parse(text);
      return { content: [{ type: 'text', text }], ...(parsed.errors ? { isError: true } : {}) };
    }
    if (name === 'resolve_task_sections') {
      const raw = args && typeof args === 'object' ? args as Record<string, unknown> : args;
      const v = validateResolveTaskSectionsArgs(raw);
      if (!v.ok) return error(v.errors);
       const text = await handleResolveTaskSections(deps, v.value.query, v.value.phase, v.value.skill, v.value.budget, v.value.includeSoft, v.value.sessionId, v.value.newSession);
      const parsed = JSON.parse(text);
      return { content: [{ type: 'text', text }], ...(parsed.errors ? { isError: true } : {}) };
    }
    if (name === 'get_token_savings_stats') {
      const v = validateTokenSavingsStatsArgs(args);
      if (!v.ok) return error(v.errors);
      const text = await handleGetTokenSavingsStats(deps, v.value.sessionId, v.value.newSession);
      return { content: [{ type: 'text', text }], ...(JSON.parse(text).errors ? { isError: true } : {}) };
    }
    if (name === 'doctor') {
      const v = validateDoctorArgs(args);
      if (!v.ok) return error(v.errors);
      return { content: [{ type: 'text', text: await handleDoctor(deps) }] };
    }
    return error([`unknown tool: ${name}`]);
  } catch (err) {
    return error([err instanceof Error ? err.message : String(err)]);
  }
}
