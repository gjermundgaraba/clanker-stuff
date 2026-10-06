# Native Pi baseline

The workspace pins Pi **1.0.3**. Provider inference/authentication/catalogs, Code Mode, MCP, coding tools, and compaction use Pi's built-ins. `codex-provider`, custom MCP, the V8 host, and their coding tools are retired; no replacement execution runtime or compatibility shim is provided.

## Local adoption

Repository changes do not upgrade installed Pi or alter user settings. Stop loading the retired provider and MCP packages in your installation before using native MCP: an extension registering `/mcp` replaces Pi's built-in implementation. Use native `/login` with `openai`; do not rename or copy legacy provider credentials.

Pi defaults to fullscreen terminal mode. Set `"tuiMode": "regular"` or pass `--tui-mode regular` to retain terminal scrollback.

Enable native Code Mode in Pi settings with `"defaultTools": ["+codemode"]`. Set `"codemode": { "mode": "only" }` for code-only declarations, or keep the default hybrid mode. Ordinary coding tools remain `read`, `bash`, `edit`, and `write`. Scripts call `tools.<name>()`, not the retired `exec`/`wait` APIs.

Configure native MCP in `~/.pi/agent/mcp.json` or trusted project `.pi/mcp.json`, under `mcpServers`. Review old entries against native configuration; do not assume saved loaded-server selections or OAuth records are interchangeable. Native `/mcp` and `pi mcp list` own discovery, connection, exposure, and authentication. Default MCP exposure is `codemode`; scripts discover tools with `searchTools()` and inspect instructions with `describeNamespace()`.

## History and execution contracts

Use a fresh session or an explicit textual handoff from a retired-provider session. Do not rewrite opaque checkpoint records, old child-model identities, or host-lifetime store data into native state. Historical files/results remain historical; they are not evidence of safe opaque replay. Native Code Mode's store is persisted and branch-aware and does not import the old V8 store.

Current evaluation conversion consumes native execution events only. It does not reconstruct retired V8 cells or interpret arbitrary tool-result trace fields. Historical reporting reads stored trajectories without rewriting archived raw logs or metrics. Exact native operation totals require closed invocation capture and matched execution records; incomplete capture retains observed lower bounds. Bounded argument/summary omission alone does not invalidate a complete execution-event capture.

Native Code Mode uses QuickJS/WASM and its own result/error/resource semantics, not the custom host's guarantees. An offline real-session probe on **0.99.2** confirmed that unawaited nested work can be aborted but outer results can finalize before delayed cleanup returns usage. This native limitation is accepted without a local patch or second runtime. Await nested calls; that guidance does not itself guarantee settlement under script failure/cancellation.

Native OpenAI subscription requests omit server output-token caps. Local output limits are not generation or billing ceilings. No live inference or backend-acceptance test was performed for this retirement.

## Optional extensions

- **Background tasks:** retained as a separate extension with ordinary Pi tools, job lifecycle, notifications, and bounded inspection output. Native Code Mode supplies nesting and permissions; no Code Mode-specific registration layer remains.
- **Subagents:** children load native Code Mode, MCP and tool search as Pi built-ins, so `-builtin:<name>` settings and replacement extensions apply; inherited selection initializes activation without freezing dynamic discovery. Root-only exclusions and native permissions remain enforced. Children may use any registered provider, including with text-only forked history. Only the hierarchical path/mailbox tools remain; mail travels through Pi's custom-message queues and is acknowledged from transcripts. Earlier control snapshots are ignored, not migrated.
- **Usage:** legacy OpenAI Codex quota reporting and its cookie transport are retired. Quota reporting is unsupported for native OpenAI; `/usage` and the `usage` status report it like any unsupported provider, without sending native credentials to a usage endpoint. Inference and session token/cost accounting remain native Pi responsibilities.
- **Fast:** the separate experimental [Fast extension](../pi/extensions/experimental/fast) uses native OpenAI subscription requests and ordinary independent extension discovery, not retired provider or live tree-adapter plumbing. Native Pi owns endpoint selection and authentication; Fast indicates best-effort priority intent, not entitlement or confirmed processing. See [behavior](../pi/extensions/experimental/fast/docs/behavior.md) and [historical verification evidence](../pi/extensions/experimental/fast/docs/verification.md); that evidence is not a fresh entitlement check.
- **Delegation and Ultra:** Subagents now separates branch-local delegation policy from its one-shot native thinking boost. Historical `ultra` entries are ignored without migration or changes to current native thinking; policy falls back to configured delegation until a new branch policy is saved. See [delegation and thinking](../pi/extensions/experimental/subagents/docs/delegation.md) for commands, inheritance and the optional orchestration preset.
- **Compaction:** native Pi textual summarization only. No remote-checkpoint adapter or standalone compaction extension is retained. Native settings/custom instructions cover ordinary policy changes.

Neither Fast nor Subagents' Ultra revives the retired provider. Future evaluations keep all three explicit arms: **Pi without Code Mode**, **Pi with Code Mode**, and **native Codex**. Historical evaluation outputs are not relabeled.
