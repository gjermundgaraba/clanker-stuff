# Contributed Code Mode tools

The shared `@clanker-stuff/code-mode-tools` package lets an owning extension supply executable definitions, not just names. Background tasks contribute all four `task_*` tools. MCP contributes connected servers' generated tools, including tools discovered or replaced during a turn.

Placement follows the selected model: `direct` keeps these tools direct; `code_mode` exposes them directly and inside `exec`; `code_mode_only` hides their direct declarations and exposes them inside `exec`. Without this provider, contributors remain ordinary Pi tools. Owner-managed enablement survives placement changes; disconnected or replaced definitions cannot be invoked by an old cell. Pi’s configured tool registry is the capability ceiling: explicit exclusions and allowlists apply to nested tools as well as direct tools. Eligibility is checked after registration and again at invocation, including for definitions retained by existing cells. Owner enablement is authoritative within that ceiling in every mode; arbitrary tool-picker selections are not reconciled with it. Disable contributions through their owning extension.

Owners stage registrations and then publish one complete enabled inventory. Publication validates proposed definitions before registering staged tools or changing placement. After registration, the published inventory and description include only tools admitted by Pi’s configured registry. A rejected inventory leaves the previous local definitions and placement intact and reports an error. Pi registration is not transactional: a host registration failure during commit cannot be rolled back, nor can this restore a disconnected MCP connection. Snapshot reads have no activation side effects; the provider projects direct versus nested placement. MCP discovery publishes once per tool-list update, not once per tool. Cross-extension snapshots are structurally validated before use.

Schemas, descriptions, and prompt guidelines live in the current `exec` description, which is built and re-registered only while Code Mode is active and discovery or reconnection changes the inventory. Direct mode still validates names but does not rebuild nested prompt metadata. Existing cells retain their original definitions; new cells receive the current inventory. Callable names use Codex's JavaScript identifier normalization. Reserved names and normalized collisions are rejected rather than silently shadowed.

## Results and accounting

Contributed calls return `{ content: [...] }`. Text items retain `{ type: "text", text }`; images become `{ type: "image", image_url: "data:..." }`. Order and multiple images survive. Parse JSON text explicitly, and call `image(imagePart)` to display an image. MCP structured content remains the bridge's bounded JSON text; opaque host-only `details` are never substituted for model-visible results.

Calls use the original executor, context, abort signal, validation, and update callback. MCP sampling accounting is drained even on failure and attributed to its originating cell. Previously unreported usage is attached once to the next outer `exec` or `wait` result observing that cell, never to another cell. Attribution is cell-level, not an exact split between execution and wait operations. Cancelling execution or explicitly terminating a cell waits for that cell's pending delegates to settle. Terminal-result finalization retains buffered notifications and traces until delegate cleanup and result attachment finish; the abandoned-cell cleanup timeout does not run against a result being finalized. Cancelling only a wait operation leaves the cell alive; its later accounting is drained by the next outer operation for that cell.

Durable accounting requires an outer tool result. If a yielded cell finishes after its last observation and the session shuts down without another wait, its remaining usage is not guaranteed to be persisted. No synthetic tool result is created at shutdown.

## Direct-only boundaries

Questionnaires and revisions, asynchronous user messaging, V2 agent-control tools, session controls, and `exec`/`wait` stay direct. Their host-visible handoffs, lifecycle ownership, or turn control are not ordinary composable return values; blocking alone is not the criterion. Existing V1 collaboration placement is unchanged. MCP manager tools (`mcp_set`, `mcp_remove`, `mcp_list`, `mcp_connect`) stay direct.

Only the outer `exec`/`wait` call passes through Pi's tool lifecycle hooks. Nested calls do **not** synthesize `tool_call` or `tool_result` events. Executor-owned MCP elicitation, sampling, cancellation, and connection behavior remain live, but third-party hook-based authorization is not a nested permission boundary. Approve the entire cell or disable Code Mode where per-tool hook enforcement is required. Contributions must not rely on turn termination; a nested result requesting it fails explicitly.

No session or MCP configuration migration is needed.
