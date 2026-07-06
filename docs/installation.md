# Installation

Ruleloom is a stdio MCP server. To use it, build the project, then point your harness at the built entry point. There is no daemon, no background process, and no network call.

## Build from source

The package is not yet on the npm registry. Run from the repo root:

```sh
npm install
npm run build
```

The build lands at `dist/index.js`. The `npm start` script runs that file directly.

```sh
npm start
# node dist/index.js  (silent until a JSON-RPC request arrives on stdin)
```

If you want a release-name to use in `npx` commands, set it once the package publishes. For now, use `node /absolute/path/to/ruleloom/dist/index.js` in your MCP config.

## Generic MCP JSON

Any MCP host that accepts a JSON server spec can run Ruleloom. The minimum shape is:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["/absolute/path/to/ruleloom/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/ruleloom` with the real path on your machine. Use forward slashes on macOS and Linux. On Windows, escape the path or use the `cmd /c npx` pattern below.

The server registers as `skill-usage-optimizer` over MCP. That name is internal and does not need to match the JSON key your harness uses for the server spec. Pick any key you like for the `mcpServers` object.

## Claude Code (CLI)

Drop a project-scoped `.mcp.json` at the repo root, or a user-scoped config in your Claude Code config directory.

`.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["/Users/me/code/ruleloom/dist/index.js"]
    }
  }
}
```

If you have Claude Code installed, the `claude mcp` command can also do this for you. Point it at the same path.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or the equivalent on Windows and Linux. Add a `mcpServers` entry:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["/Users/me/code/ruleloom/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing. Ruleloom will appear in the MCP tools list.

## Codex CLI

Codex reads `~/.codex/config.toml` or a project `.codex/config.toml`. Add a `[mcp_servers.ruleloom]` table:

```toml
[mcp_servers.ruleloom]
command = "node"
args = ["/Users/me/code/ruleloom/dist/index.js"]
```

Or use the Codex CLI:

```sh
codex mcp add ruleloom -- node /Users/me/code/ruleloom/dist/index.js
```

## OpenCode

OpenCode reads `opencode.json` (or `~/.config/opencode/config.json` for global). Add an `mcp` block:

```json
{
  "mcp": {
    "ruleloom": {
      "type": "local",
      "command": ["node", "/Users/me/code/ruleloom/dist/index.js"]
    }
  }
}
```

OpenCode accepts both the array form above and a single `command` string. The array form is safer because it does not require shell parsing of spaces in paths.

## VS Code and Copilot Chat

VS Code reads `mcp.json` from a few locations. The user-scoped file lives at:

- macOS: `~/Library/Application Support/Code/User/mcp.json`
- Windows: `%APPDATA%\Code\User\mcp.json`
- Linux: `~/.config/Code/User/mcp.json`

Or drop a workspace-scoped `.vscode/mcp.json` in the repo. Same shape:

```json
{
  "servers": {
    "ruleloom": {
      "command": "node",
      "args": ["/Users/me/code/ruleloom/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

VS Code uses `servers` (plural) and may also accept `mcpServers`. Try the form that matches your version.

## Cursor

Cursor reads `~/.cursor/mcp.json` for global MCP servers, or `.cursor/mcp.json` in a project. The shape is the standard MCP spec:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "node",
      "args": ["/Users/me/code/ruleloom/dist/index.js"]
    }
  }
}
```

Restart Cursor after editing. The tools show up in the Composer tool list.

## Generic stdio MCP host

Any host that can launch a subprocess and speak MCP over stdio will work. The contract:

- Launch: `<command> <args...>`
- Transport: stdio. JSON-RPC 2.0 on stdin/stdout. Ruleloom writes logs to stderr only, never stdout.
- Capabilities: `tools` only. Ruleloom exposes six tools. See [tool-reference.md](tool-reference.md).
- Lifecycle: the server runs until the harness closes stdin or kills the process. There is no init handshake beyond the standard MCP `initialize` request.

## Windows: `cmd /c npx` pattern

On Windows, hosts that need a single string command (instead of a command + args array) sometimes fail on `node` if it is not on `PATH`. The reliable fix is to launch through `cmd /c` with the full path quoted, or to use `npx`:

```json
{
  "mcpServers": {
    "ruleloom": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "<package-name>", "--prefix", "C:\\path\\to\\ruleloom"]
    }
  }
}
```

If you have built Ruleloom locally and want to skip `npx`, the equivalent direct form is:

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

The `cmd /c` form is the only safe way to run a Windows binary from a JSON spec that has no shell. Some hosts accept array `args` and will run `node` directly without `cmd /c`. Try the array form first; fall back to `cmd /c` only if Windows cannot find `node.exe`.

## Verifying the install

From your agent, run:

```json
{ "name": "list_skills", "arguments": {} }
```

You should see:

```json
{ "skills": [], "count": 0 }
```

If you see `{ "errors": ["no skills indexed"] }` from `load_skill_context`, that's normal on a fresh install. Run `index_skills` first. See [agent-guide.md](agent-guide.md) for the bootstrap sequence.

## Where the cache goes

Ruleloom writes to `<cwd>/.skill-cache/` where `<cwd>` is the working directory of the MCP process. Most harnesses launch MCP servers with the project root as `cwd`, so the cache lands inside the project. If you need a different location, embed Ruleloom programmatically and pass `McpServerOptions.storeDir`.

## Updating

To pick up new changes:

```sh
git pull
npm install
npm run build
```

Then restart your harness so it relaunches the MCP server with the fresh `dist/index.js`.
