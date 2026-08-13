# MCP configuration

The MCP extension reads server configuration from:

1. Global config: `<agent-dir>/mcp.json`, normally `~/.pi/agent/mcp.json`
2. Project-local config: `<current-cwd>/.pi/mcp.json`

The extension honors Pi's configured agent and project-directory names.

Both files use the same shape:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "streamable-http",
      "url": "https://example.com/mcp",
      "oauth": {}
    }
  }
}
```

When both files exist, `mcpServers` is merged shallowly. Project-local servers override global servers with the same name.

Project-local configuration is loaded only after pi marks the current project as trusted. Lookup is limited to `.pi/mcp.json` under the current pi working directory; parent directories are not searched.

## MCP manager

`/mcp` always includes the built-in `mcp-manager`, even when no config exists or a config is invalid. Loading it exposes four tools:

- `add_mcp` adds a stdio or HTTP server to one config scope. Existing names are not overwritten.
- `remove_mcp` removes a server from one config scope. It does not unload tools already active in the session.
- `list_mcps` lists effective server names and scopes without returning commands, arguments, environment values, URLs, headers, or OAuth settings.
- `connect` loads a server through the same connection path as selecting it from `/mcp`.

The name `mcp-manager` is reserved and cannot be added. A manually configured collision is ignored, but `remove_mcp` can delete it from a selected scope.

## Security note

Project-local `.pi/mcp.json` files are executable configuration. A server entry can define `stdio` commands that run local programs, and HTTP servers can receive context and tool arguments sent by the agent.

Pi's project trust gate prevents this extension from reading or modifying `.pi/mcp.json` in an untrusted project. Review the file before trusting an unfamiliar repository. Manager mutations preserve `${VAR}` placeholders and use atomic writes, but tool arguments are still stored in the pi session; prefer environment placeholders over literal secrets. Previously loaded servers reconnect without opening a browser; run `/mcp` explicitly when interactive OAuth is required.

Truncated MCP tool output is persisted with private permissions. Each file is limited to 1 MiB, and the newest 10 files are retained up to 5 MiB total. Older output paths shown in session history can therefore expire.
