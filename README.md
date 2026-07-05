# skill-usage-optimizer

Utilities for discovering skill/instruction artifacts and normalizing them into stable inputs.

## Install

```sh
npm install skill-usage-optimizer
```

## API

```ts
import { discover, normalize } from 'skill-usage-optimizer';

const ctx = {
  workspaceRoot: process.cwd(),
  repoRoot: process.cwd(),
  homeDir: process.env.HOME!,
  includeGlobals: true,
  includeSystem: false,
  explicitRoots: []
};

const discovered = discover(ctx);
const normalized = normalize(discovered.artifacts, ctx);
```

- `discover(ctx)` finds supported Claude, opencode, Codex, Copilot, and explicit-root artifacts.
- Explicit roots are attributed by path heuristic, or by `explicitRootSystem` when a caller supplies one (for example, MCP `index_skills` roots use the requested system).
- `normalize(artifacts, ctx)` reads safe artifacts and returns normalized markdown inputs with metadata.

## MCP Server

Starts an MCP server via stdio transport:

```json
{
  "mcpServers": {
    "skill-usage-optimizer": {
      "command": "npx",
      "args": ["skill-usage-optimizer"]
    }
  }
}
```

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```
