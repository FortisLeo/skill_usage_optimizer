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
import { FileStore } from '../store/fileStore.js';
import type { ToolDeps } from './tools.js';
import {
  handleIndexSkills,
  handleListSkills,
  handleGetSkillManifest,
  handleGetSkillSections,
  handleLoadSkillContext,
  handleLoadSection
} from './tools.js';
import {
  validateIndexSkillsArgs,
  validateListSkillsArgs,
  validateGetSkillManifestArgs,
  validateGetSkillSectionsArgs,
  validateLoadSkillContextArgs,
  validateLoadSectionArgs
} from './schemas.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const TOOL_DEFS = [
  {
    name: 'index_skills',
    description: 'Discover, normalize, and compile skills from a source system into the local cache.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', enum: ['claude', 'opencode', 'codex', 'copilot'] },
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
        system: { type: 'string', enum: ['claude', 'opencode', 'codex', 'copilot'] }
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
  }
];

export interface McpServerOptions {
  storeDir?: string;
  homeDir?: string;
  workspaceRoot?: string;
}

export async function startMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const storeDir = opts.storeDir ?? resolve(process.cwd(), '.skill-cache');
  const homeDir = opts.homeDir ?? homedir();
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();

  const fileStore = new FileStore(storeDir);
  await fileStore.init();

  const deps: ToolDeps = {
    discover,
    normalize,
    // ponytail: adapter — compiler returns Map|Record union, handler expects Map
    compile: (inputs, ctx) => {
      const result = compile(inputs, ctx);
      return {
        store: result.store instanceof Map ? result.store : new Map(Object.entries(result.store)),
        errors: result.errors,
        manifests: result.manifests
      };
    },
    loadContext,
    store: fileStore,
    resolveHomeDir: () => homeDir,
    resolveWorkspaceRoot: () => workspaceRoot
  };

  const server = new Server(
    { name: 'skill-usage-optimizer', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
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