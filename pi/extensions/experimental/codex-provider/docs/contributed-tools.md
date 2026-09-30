# Code Mode capabilities

Code Mode uses Pi's ordinary tool registry, not a cross-extension inventory protocol. Background tasks and generated MCP tools register through `ContentTools` from `@clanker-stuff/code-mode-tools`; V1 collaboration and the provider's shell/file tools register their own structured results. Any eligible registered tool can be called from JavaScript. The native wire inventory lists callable deferred tools too; it does not implement Pi's separate deferred-tool search surface.

## Placement and discovery

`direct` declares ordinary tools to the model. `code_mode` also declares `exec`. `code_mode_only` uses `exec.prepareLoadout()` to hide callable tools' declarations without deactivating their capabilities. Tools with `model-only` exposure remain declared and cannot be called inside scripts. Pi's explicit exclusions and allowlists remain the capability ceiling.

Owners stage content-tool definitions and call `setEnabled()` once per discovery update. Enabled tools use `direct` exposure; disabled tools use `hidden`. Foreign name collisions are rejected before registration. Pi registration is not transactional: an actual host registration failure cannot be rolled back, nor can registration restore a disconnected MCP server. Tool-picker activation is ordinary Pi state, not a second owner inventory to reconcile.

Pi refreshes loadouts after dynamic registration. Current callable schemas and descriptions appear in the `exec` description; namespaces determine JavaScript names. Reserved names and normalized collisions are rejected. An executing script has a wire inventory, not retained executable definitions: each invocation checks current capability availability and calls `ctx.executeTool()`, which resolves the current registered executor. Removed or hidden capabilities cannot be revived by an old script.

## One active exec

Each `exec` owns its script until completion, failure or cancellation. The native V8 host remains responsible for isolates, timers, JSON stores and script output. Host yields and `session/wait` are internal operations; there is no model-facing `wait`, `cell_id`, termination call or `yield_time_ms` pragma. Use process sessions or background-task tools for work that must outlive a tool call.

When a script finishes, unawaited delegates are cancelled and settled before the result returns. Cancellation likewise settles delegates and terminates the cell. If cancellation arrives before the host supplies a cell handle, the host process is stopped rather than leaving an unowned cell; other in-flight scripts on that process also fail. Buffered output, bounded notifications and detached trace snapshots are retained through finalization, then execution state is removed. Presentation callback failures do not change tool execution.

## Results and accounting

Pi owns argument preparation, validation, permission hooks, execution policy, nested call IDs and parent-linked lifecycle events. The adapter only bridges function/freeform arguments, native wire names, script values, output schemas and cancellation. A nested result requesting turn termination fails explicitly; the adapter does not claim to implement Pi turn control inside a script.

Tools with output schemas return validated `structuredContent`. Content tools return `{ content: [...] }`: text keeps `{ type: "text", text }`; images become `{ type: "image", image_url: "data:..." }`, preserving order and multiplicity. Parse JSON text explicitly and use `image(imagePart)` to display an image. MCP structured content remains bounded JSON text; private host `details` never replace the script's return value. Other tools return text or a supported image.

Received MCP sampling usage is returned on the tool result, including failed results. Pi sums nested usage onto the owning outer `exec` result and persists its bounded `nestedCalls` record. There are no accounting drains, cross-turn cell ledgers or synthetic shutdown results. This guarantees attribution for usage returned by delegates, not usage a remote provider never reports. Durable accounting still requires Pi to persist the outer result.

## Model-only boundaries

Questionnaires/revisions, asynchronous user messaging, V2 agent controls, MCP manager tools and `exec` have `model-only` exposure. Their handoffs or lifecycle/turn-control ownership are not ordinary composable values. V1 collaboration stays callable with its declared namespace and result schemas.

Nested authorization is no longer aggregate-only: the real Pi `tool_call` and `tool_result` hooks run for each nested call and carry `parentToolCallId`. Existing MCP elicitation, sampling and connection behavior remains live. Authorization extensions must use Pi's nested event metadata when distinguishing outer from nested calls.

This is a clean break in the contributed-tools API and model-facing Code Mode lifetime, not a persisted session or MCP configuration migration. Historical tool cards remain renderable; executable cells do not survive tool completion or restart.
