# Testing MCP

The development fixture lives in `tests/fixtures/server.ts`; automated stdio tests and the HTTP/OAuth wrapper use the same tool implementation. It is excluded from the published extension. Run commands from the repository after `vp install` with Node 26 or newer.

```sh
node pi/extensions/mcp/tests/fixtures/server.ts capabilities --http
node pi/extensions/mcp/tests/fixtures/server.ts normal --http --oauth
node pi/extensions/mcp/tests/fixtures/server.ts roots
```

HTTP listens only on an OS-assigned `127.0.0.1` port and prints its MCP URL. Ctrl+C closes the listener and releases paused requests. Stdio reserves stdout for MCP. Use an isolated trusted temporary workspace for manual configuration and remove it afterward. In that workspace, create `.pi/mcp.json` using the printed port:

```json
{
  "mcpServers": {
    "fixture": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp"
    },
    "stdio-fixture": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/REPO/pi/extensions/mcp/tests/fixtures/server.ts", "roots"]
    }
  }
}
```

For the OAuth fixture, add `"oauth": {}` to its HTTP configuration. `/mcp` connects the selected server. `/mcp` → `mcp-manager` also exposes `mcp_set`, `mcp_connect`, `mcp_list`, and `mcp_remove` for exercising manager behavior against this same server. Keep real credentials and ordinary global configuration out of the fixture workspace.

## Scenarios and expected results

Choose the scenario as the first command argument. Restart/reconnect to change discovery schemas. `interact` accepts `maxTokens` (default 8) and `rounds` (default 1, maximum 8); `search` accepts `query` except in `changed`, where it accepts `term`.

| Scenario                               | Expected result                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `normal`                               | `search` returns `result: QUERY`                                                 |
| `changed`                              | Reconnect replaces `query` with required `term`                                  |
| `collision`                            | `foo-bar` and `foo_bar` get distinct stable Pi names                             |
| `large`, `error`                       | Truncated text, overflow file; `error` also marks tool failure                   |
| `image`, `structured`, `mixed`         | A valid PNG, structured JSON, or ordered text/image output                       |
| `form`                                 | Typed fields, single/multiple choices, final review, accept/decline/cancel       |
| `roots`                                | The originating call's workspace URI                                             |
| `url`                                  | Local interaction page; Open URL precedes browser navigation, Completed resumes  |
| `sampling`                             | Automatic selected-model text sample; use a supported GPT-5 Codex model          |
| `capabilities`                         | Form, roots, and sampling in one continuation round                              |
| `rounds`                               | Repeated forms when `rounds` exceeds 1                                           |
| `continuation-error`, `sampling-error` | Input or sampling succeeds, then the resumed operation fails                     |
| `stalled` (HTTP)                       | Tool waits until released or cancelled                                           |
| `malformed` (HTTP)                     | First tool result fails SDK result validation                                    |
| `drop` (HTTP)                          | A request loses its connection                                                   |
| `expired` (HTTP)                       | First legacy session tool call receives HTTP 404; automatic reconnect, no replay |
| `expired-ping` (HTTP)                  | First idle ping receives HTTP 404; automatic reconnect before a tool call        |

For HTTP, `GET /records` shows protocol request methods, application rounds, and completed-operation counts. Normal continuation rounds increment the wire-request count but perform the final operation once. Repeat a sampling call with `maxTokens: 1` and `rounds: 3`, then run overlapping calls: each operation must retain its workspace/model and usage. Cancel while a form or sample is pending; queued prompts must disappear and no final operation should run.

Control the running HTTP fixture with `POST /control?action=VALUE`. Values are `pause`, `release`, `expire-access`, `reject-refresh`, `reject-refreshed`, `more-scope`, `malformed-next`, and `drop-next`. For example:

```sh
curl -X POST 'http://127.0.0.1:PORT/control?action=pause'
curl -X POST 'http://127.0.0.1:PORT/control?action=release'
curl 'http://127.0.0.1:PORT/records'
```

OAuth cases reuse stored tokens, expire them to exercise refresh (including during idle pings), reject refresh or returned credentials, and require additional scopes. Authorization failures must request explicit reconnect instead of silently opening a browser. Session-expiry failures reconnect automatically but never replay a tool call. The local `/authorize` endpoint supplies a deterministic authorization code; `/interaction` is the separate URL-interaction page.

For a quick idle-recovery check, run `expired-ping --http` and configure `heartbeatIntervalMs: 1000` with `heartbeatTimeoutMs: 5000`. Load the server and wait: `/records` should show another initialization without any tool calls. The first real tool call should succeed. Pings may prevent server-defined idle expiry but do not guarantee renewal. Normal defaults are a 60-second interval and a 10-second ping timeout; `heartbeatIntervalMs: 0` disables pings. Unit tests use the extension host and controlled clocks to cover flapping connections, sustained-health backoff reset, capped retries through prolonged outages, non-overlapping pings, active calls, branch deactivation, explicit reconnect supersession, unsupported pings, and shutdown cleanup.

## Automated validation

```sh
vp test --project unit pi/extensions/mcp
vp test --project integration pi/extensions/mcp
vp check pi/extensions/mcp
```

Unit/contract tests use the real SDK over stdio and HTTP with isolated temporary config, credential, and result directories. They cover manager/configuration precedence, trust, expansion, OAuth, discovery/schema replacement, cancellation, forms, roots, URL interactions, concurrent continuations, result conversion, and replay protection. Sampling protocol tests use a deterministic model/scope stub; they establish request translation, ownership, usage attribution, and cleanup calls, not the provider's tokenizer or backend limits. Real `AgentSession` integration verifies dynamic tool wiring and sampling usage in successful and failed session history.

The Codex provider's sampling tests separately drive its real adapter through Pi's registry using controlled SSE and WebSocket responses. Their token-bound, cancellation, usage, and runtime-record checks are the evidence for enabling supported model combinations. Local transport fixtures do not establish a native backend generation ceiling. Manual runs exercise real UI and selected-model inference; preserve that distinction when reporting results.
