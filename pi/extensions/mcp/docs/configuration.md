# MCP configuration

The extension reads two files:

1. Global: `<agent-dir>/mcp.json`, normally `~/.pi/agent/mcp.json`
2. Project: `<current-cwd>/.pi/mcp.json`, only when Pi trusts the project

Pi's configured agent and project-directory names are honored. Parent directories are not searched. Project entries override global entries with the same name, even when the project entry is invalid. An object without `mcpServers` is an empty configuration. An invalid server entry does not prevent connecting other servers; malformed JSON or an invalid document structure (including a present `mcpServers` that is not an object) must be repaired first.

## Server definitions

```json
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "oauth": {}
    },
    "local": {
      "type": "stdio",
      "command": "my-mcp-server",
      "args": ["--token", "${MCP_TOKEN}"],
      "env": { "LOG_LEVEL": "${MCP_LOG_LEVEL:-warn}" }
    }
  }
}
```

Supported types are `stdio` and `http`. HTTP uses the MCP SDK's automatic protocol negotiation, including legacy Streamable HTTP servers. There is no separate SSE transport option. Stdio processes start in the current Pi working directory.

String fields support `${VAR}` and `${VAR:-fallback}`. Missing variables without a fallback fail only when that server is connected. Stored configuration retains the placeholders. Server definitions reject unknown fields to catch typos; unrelated top-level document fields and other server entries survive manager edits.

HTTP entries accept optional `headers`, a string-to-string map. Set `oauth: {}` for browser-based OAuth with dynamic client registration, or omit `oauth` for unauthenticated/header-authenticated servers. OAuth options:

- `clientId`, `clientSecret`: pre-registered client credentials, when required by the provider.
- `clientName`: registration display name; defaults to `pi MCP`.
- `scopes`: space-separated requested scopes. These are combined with scopes required by server challenges, without duplicates. If neither is supplied, the SDK uses discovery defaults.
- `authServerMetadataUrl`: explicit authorization-server metadata URL instead of initial discovery.
- `callbackPort`: fixed localhost callback port for providers requiring an exact redirect URI. Otherwise the OS allocates a free port. The callback path is `/callback`.

`clientSecret` configures client authentication for the authorization-code flow, not a client-credentials grant. When registering a static client, allow the chosen `http://localhost:<port>/callback` redirect URI.

## Loading and reconnecting

Run `/mcp` and choose a server. Choosing an already connected server replaces the connection and refreshes its configuration and tool schemas. Removed tools are deactivated. Generated tool names contain a readable prefix and a stable identity hash and fit provider name limits.

Loaded server names are saved in the session branch. Restoring a branch activates its servers without opening a browser; failed restores produce a warning. A closed connection or expired MCP session temporarily deactivates its tools while the extension reconnects automatically. Recovery uses the last successfully loaded configuration and existing OAuth credentials, then rediscovers and activates the current tool schemas. Changing a file alone does not reload an active connection.

Connection operations are serialized per server. Ordinary connects reuse a healthy connection; explicit reconnects always replace it. Cancellation prevents queued operations from starting.

Automatic recovery starts immediately, then waits 1, 2, 4, 8, 16, and 32 seconds between attempts, capped at 60 seconds thereafter while the server remains selected. Each attempt, including tool discovery, is bounded to 30 seconds. Backoff is retained across short-lived connections and resets only after a successful ping or tool response on a connection that has stayed open for at least 60 seconds. A continuing outage produces one warning when retries reach the cap; retries continue without manual intervention. Authorization failures stop recovery immediately and warn; use `/mcp` or `mcp_connect` to authorize again. Explicit connects supersede background recovery without waiting for backoff. Branch restoration preserves ongoing recovery for servers that remain selected, without waiting for them before restoring other servers. Deselecting a server or shutting down cancels its background work.

The extension never automatically replays a failed tool call, including after a session-expiry HTTP 404. The original call still reports an error; the repaired connection serves subsequent calls. A failed response does not prove that a mutating operation did not execute. Verify its outcome before retrying it.

Connection establishment is bounded to 30 seconds per attempt. Established tool calls use the SDK's request timeout and caller cancellation, not the setup deadline. Streaming response bodies have no additional extension-imposed deadline.

### Background heartbeats

HTTP and stdio server entries accept two optional settings:

- `heartbeatIntervalMs`: idle ping interval in milliseconds; defaults to `60000`. Set to `0` to disable background pings without disabling automatic recovery from session-expiry responses or connection closure.
- `heartbeatTimeoutMs`: ping timeout in milliseconds; defaults to `10000` and must be positive.

Pings run only for servers selected in the current branch. They do not overlap, and are skipped while tool calls or their interactions are active. A failed idle ping triggers automatic recovery; a server/protocol that does not support `ping` has heartbeats disabled for that connection instead. Background authorization can refresh existing OAuth tokens but never opens a browser.

Pings detect stale sessions before a real tool call needs them. They may also prevent idle expiry if the server treats them as activity, but MCP does not guarantee session renewal or expose a standard session lifetime. Servers can still terminate sessions between pings. See [MCP ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping) and [session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management).

## MCP manager

`/mcp` always includes `mcp-manager`, even with no configuration or a malformed file. Selecting it enables four native Pi tools; it does not start another MCP server:

- `mcp_set`: create or replace a complete server entry in `global` or trusted `project` scope. Replacement does not merge with the previous entry or reload an active connection.
- `mcp_remove`: remove a server from one scope, including invalid entries. An absent entry is success without creating or rewriting a file. This does not unload tools already active in the session.
- `mcp_list`: list effective names, scopes, and validation diagnostics without exposing configuration values.
- `mcp_connect`: connect a named server. Set `reconnect: true` to reload an active server's configuration and tool schemas.

Manager tools use the current execution context's working directory and trust decision. The name `mcp-manager` is reserved; a manually configured collision is ignored but can be removed with `mcp_remove`.

## OAuth and credentials

Valid access tokens are reused without opening a browser, including tokens without refresh tokens. Refreshes are serialized across Pi processes sharing a connection identity. Browser interaction is limited to explicit interactive connects; ordinary tool execution never launches a browser. Expired grants, rejected refreshed tokens, or additional required scopes prompt an explicit reconnect. If refresh cannot restore access, an explicit interactive connect starts browser reauthorization.

In TUI mode, `/mcp` and `mcp_connect` open the authorization URL in the default browser after the callback listener is ready. The URL is also displayed for manual use if browser launch fails. RPC displays the URL without opening a browser on the host. Cancellation closes the callback listener; OAuth network requests and lock acquisition have bounded waits.

Credentials live in `<agent-dir>/data/mcp/oauth/<identity-hash>.json`, with private file permissions and atomic writes. Identity includes the expanded endpoint URL, headers, client ID/secret, scopes, metadata URL, and callback port. The server's display name and OAuth `clientName` do not affect credential identity. Changing identity fields uses a new credential file. PKCE verifiers stay in memory, and the client registration and discovery snapshot are pinned for each browser handshake. A corrupt credential file affects only that identity; the error identifies the file to fix or remove before authorizing again.

## Output and security

Project `.pi/mcp.json` files are executable configuration. Stdio entries run local programs, and HTTP servers receive tool arguments and any context sent to them. Review unfamiliar configuration before trusting a project. Pi's trust gate prevents the extension from reading or modifying project configuration in an untrusted project.

Manager mutations are queued and atomic. Tool arguments are still stored in the Pi session: prefer environment placeholders over literal secrets.

Text output uses Pi's standard truncation limits; supported images retain their position among text blocks. Structured output is appended unless an existing text payload already contains equivalent JSON. Distinct text and structured data are both retained. Overflow is saved under `<agent-dir>/data/mcp/results/` with private permissions, capped at 1 MiB per file. Files older than seven days are eligible for cleanup on the first overflow write of each extension runtime. There is no aggregate size or file-count quota. Paths in session history are temporary, and saved output may itself be partial. A persistence failure produces a warning without converting a successful remote operation into a failed tool call.

## Forms, links, and workspace roots

Connected servers can request forms and URL interactions during tool calls. Requests identify the server and use the context of the originating tool execution, including when multiple servers or tools run concurrently. Roots are also available during initialization and while idle, using the current Pi session workspace. Roots requested within a tool call use that call's workspace. Session changes update existing connections without retaining an old context. Roots advertise the workspace as a `file:` URI; they do not enforce filesystem access.

Forms preserve strings, numbers, integers, booleans, single choices, and multiple string choices. Optional fields can be skipped. Defaults are suggestions; they never submit a response. Review the completed form, then choose Accept, Decline, or Cancel. Headless runs return Cancel. Form and link prompts share the question extension's UI queue. Cancellation, branch/session replacement, connection closure, and shutdown release active and queued interactions.

URL interactions show the destination before the user chooses Open URL. TUI opens the browser only after that choice; RPC displays a link for manual navigation. Choose Completed after finishing in the browser. Legacy server completion notifications also finish a waiting interaction. URL interactions are separate from OAuth authorization to connect Pi to a server.

The SDK's existing continuation engine fulfils embedded input requests and carries opaque request state across rounds. Modern calls can overlap. Legacy reverse requests do not carry a reliable originating-call identity, so calls on a legacy connection are serialized. Form, URL, and sampling requests outside a tool call are rejected rather than borrowing session context. SDK roots and sampling APIs remain intentionally supported despite their 2026-07-28 deprecation.

## Automatic model sampling

Servers may request sampling without a per-server switch or confirmation. Sampling uses the model selected when the originating tool starts, through Pi's model registry and authentication. It receives only server-supplied text messages and system instructions. Pi history, local tools, and recursive agent execution are excluded. Server model preferences do not override the selected Pi model.

As of 2026-09-13, automatic inference requires the Codex extension's bounded sampling scope and a supported GPT-5 model. Other adapters and Astra are rejected before inference because a verified token-accounting and request-disposal contract is not available for them. There is no silent unbounded fallback. Image/audio inputs, tools, non-text outputs, invalid budgets, and empty stop sequences are rejected. Positive integer budgets are capped at the selected model's output limit.

For supported Codex models, the provider limits the returned concatenated text using the model's verified tokenizer and aborts streaming when the limit is reached. MCP reports `maxTokens` at that boundary. Reasoning is not returned and is excluded from the returned-text budget. Backend reasoning and output generated before cancellation can still incur usage. Client cancellation is best effort; this is not a native backend generation or billing ceiling. No native generation-limit guarantee is claimed.

Each sampling operation owns a fresh provider scope. Completion, failures, cancellation, length limits, and conversion errors all await explicit scope disposal, which releases its transport and continuation state. Ordinary Pi sessions and overlapping sampling operations remain independent. Provider-reported usage is attached to the originating tool result, including unsuccessful later continuations; each sample also records whether accounting is complete. Incomplete accounting means final usage did not arrive, not zero usage or an exact saving.

See [Testing MCP](testing.md) for the shared local server, automated coverage, and manual scenarios.
