# MCP configuration

The MCP extension reads server configuration from:

1. Global config: `~/.pi/agent/extensions/mcp.json`
2. Project-local config: `<current-cwd>/.mcp.json`

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

Project-local configuration is loaded only after pi marks the current project as trusted. Lookup is limited to `.mcp.json` directly under the current pi working directory; parent directories are not searched.

## Security note

Project-local `.mcp.json` files are executable configuration. A server entry can define `stdio` commands that run local programs, and HTTP servers can receive context and tool arguments sent by the agent.

Pi's project trust gate prevents this extension from reading `.mcp.json` in an untrusted project. Review the file before trusting an unfamiliar repository. Previously loaded servers reconnect without opening a browser; run `/mcp` explicitly when interactive OAuth is required.
