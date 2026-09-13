# Codex upstream review — 2026-09-13

## Scope and provenance

The reusable checkout at `~/.cache/checkouts/github.com/openai/codex` was clean and fast-forwarded from `02a8f038b87ad34d4a1dc5058eda26972ed7aa6c` to [`36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`](https://github.com/openai/codex/tree/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564), committed 2026-09-13 13:06:40 UTC. Review covered relevant changes across the 547 commits since the September 2 behavior baseline, `389dd5645944891b65e4ca584125bbb0c852d352`, and catalog changes since `f1aac1e885f676a1129f2da0c46a3dba86392fc6`. Pi remains pinned to `v0.85.0`.

This is a source-diff review, not proof of complete parity with current Codex. The older [provider baseline](codex-baseline.md), [collaboration contract](../../subagents/docs/codex-model-facing-contract.md), and [application reference](../../subagents/docs/codex-reference.md) retain their historical source links. Recommendations below have not been implemented by this refresh.

The collaboration extractor and generated fixture now pin both selected tool facts and catalog declarations to `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`. Regeneration changed only the two revision fields: V1/V2 tool families, namespaces, alphabetical namespace ordering, stock V2 spawn properties/output, and Luna V1 versus Sol/Terra/Astra V2 declarations are unchanged. These checks do not cover full tool schemas, prompts, runtime behavior, visibility, or the rest of the catalog.

## Recommended extension work

### 1. Reset provider routing when account ownership changes

Upstream [`537278c65f`](https://github.com/openai/codex/commit/537278c65f) clears turn routing as well as cached transport when auth ownership changes; see [`client.rs`](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/core/src/client.rs). Locally, [`provider.ts`](../provider.ts) reconnects a WebSocket when its header identity changes, but `closeSocket` clears only the socket and continuation. `applyTurnHeaders` can still reuse `session.turn.state` with the new credentials during the same live turn. Account-scoped model and usage cache invalidation does not reset that state.

Track account ownership separately from bearer-token rotation and clear account-owned turn routing before building either HTTP or WebSocket requests. Regression coverage should switch accounts after observing turn state, exercise both transports and prewarm, and distinguish a same-account token refresh. This is the highest-priority correctness follow-up; the source review did not reproduce it against the live backend.

### 2. Refresh Astra's offline fallback visibility

Upstream [`a97cf1b72e`](https://github.com/openai/codex/commit/a97cf1b72e) changes Astra to `visibility: list` in the [bundled catalog](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/models-manager/models.json). Local [`model-catalog.ts`](../model-catalog.ts) still seeds `hide`. Live refresh already honors `list`; the remaining difference affects initial/offline discovery.

Update that fallback and its picker expectations. Astra's context limits, effort presets, Ultra mapping, tool mode, and service tiers did not change in the compared catalog. The new `supports_experimental_context` field belongs to a separate context-budget feature decision. Upstream also removed bundled `gpt-5.2` and `gpt-5.4-mini`; review the policy for Pi-derived historical fallback entries before removing resume support.

### 3. Investigate MCP input continuation

Upstream [`c6a59ef923`](https://github.com/openai/codex/commit/c6a59ef923) adds handling for `input_required` tool results, request state, bounded continuation rounds, cancellation on connection close, and no replay after submitting verification proof; see [`tool_input.rs`](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/rmcp-client/src/tool_input.rs).

Local [`mcp/servers.ts`](../../../mcp/servers.ts) delegates to the MCP SDK's `client.callTool`. Inspection of the installed `@modelcontextprotocol/client` 2.0.0 shows that it already handles bounded input continuation automatically through registered elicitation/sampling/roots handlers. [`connection.ts`](../../../mcp/connection.ts) enables automatic protocol negotiation but registers none of those host handlers or capabilities. Exercise an input-requesting server and decide which capabilities and UI to support using the SDK's existing continuation engine. Native OpenAI verification requires its own host capability; this review does not establish that ordinary MCP calls are broken.

### 4. Consider asynchronous user interaction as separate product work

Native asynchronous questions already existed at the old baseline. New work adds free-form asynchronous messages ([`d6350e24be`](https://github.com/openai/codex/commit/d6350e24be)) and TUI answer selection/inline Other behavior ([`218e8df926`](https://github.com/openai/codex/commit/218e8df926), [`07f18d5ff7`](https://github.com/openai/codex/commit/07f18d5ff7), [`c126b0d8ef`](https://github.com/openai/codex/commit/c126b0d8ef)).

Local [`ask-question`](../../../ask-question/tool.ts) awaits a prompt, already supplies Other, and aborts on cancellation. An asynchronous sibling could let work continue while awaiting input, but requires pending-question state, answer delivery, and lifecycle design. Keep the existing strict persisted tool schema; this is not a rename or compatibility-field addition.

### 5. Consider richer usage display without advertising Reserve support

Codex now records ordinary-usage eligibility and model-associated additional limits through [`577a4fcd06`](https://github.com/openai/codex/commit/577a4fcd06) and [`5037919777`](https://github.com/openai/codex/commit/5037919777). Local [`usage/adapters/codex.ts`](../../usage/adapters/codex.ts) displays ordinary primary/secondary windows and credits. Additional-limit display is a possible enhancement.

The upstream [usage client](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/backend-client/src/client/rate_limit_resets.rs) explicitly limits the Luna Reserve opt-in header to clients that can apply Reserve. The passive usage reader should continue omitting it. There is no new rate-limit header parser repair indicated by this diff.

## Collaboration reference changes

- **V2 environment child inventory:** [`d665e3bbc8`](https://github.com/openai/codex/commit/d665e3bbc8) includes registered unloaded direct children, uses canonical paths without nicknames, prioritizes resident children, and bounds the block to eight children and 1,024 bytes. This supersedes only the V2 portion of the historical loaded-only account in contract §10 and parity `CTX-02`. Non-V2 protocols retain loaded-only enumeration and nickname formatting. Pi currently omits this native environment block. Consider an extension-owned bounded V2 child summary if prompt parity warrants it; do not change the separate `list_agents` tool's loaded-runtime semantics.
- **Role personality changes:** [`132c739171`](https://github.com/openai/codex/commit/132c739171) narrows model-owned instruction regeneration to effective personality opt-out changes. The historical contract §8 describes the earlier broader trigger. Pi does not implement native personality configuration.
- **Forked context and trusted state:** [`0d502a4230`](https://github.com/openai/codex/commit/0d502a4230), [`87628df77a`](https://github.com/openai/codex/commit/87628df77a), [`9c4253ffc1`](https://github.com/openai/codex/commit/9c4253ffc1), and [`8260619cb6`](https://github.com/openai/codex/commit/8260619cb6) retain configuration updates and scope inherited user/Guardian authorization evidence. This extends the historical context-sanitization description; Pi must not fabricate Guardian state.
- **Instruction capture and protocol inheritance:** [`fc948f8c47`](https://github.com/openai/codex/commit/fc948f8c47) captures child instructions before residency eviction; [`cc737efd65`](https://github.com/openai/codex/commit/cc737efd65) preserves protocol on cutoff forks. Local [`runtime.ts`](../../subagents/runtime.ts) captures context files and [`manager.ts`](../../subagents/manager.ts) carries the protocol latch. No concrete local fix was identified.
- **Delegated attribution:** [`e004dc6a4b`](https://github.com/openai/codex/commit/e004dc6a4b) carries the originating turn trigger through delegation. This expands the backend-lineage boundary already recorded in the application reference; it does not justify inventing Codex provenance.

## Provider features and host boundaries

- **Reasoning-effort history:** [`56a8470aa0`](https://github.com/openai/codex/commit/56a8470aa0) and [`35d9e4bc4d`](https://github.com/openai/codex/commit/35d9e4bc4d) add trusted configuration-update history, a pinned inference effort, its use during compaction, and reset after successful compaction. This is gated by `ReasoningEffortOverride`; adopting it requires a lifecycle/persistence decision, not forwarding a new effort field.
- **Image detail:** [`6eecd04fc1`](https://github.com/openai/codex/commit/6eecd04fc1) downgrades retained `original` detail for receiving models that do not support it. Pi's public Responses converter currently emits `auto`, and the local Lite path strips unsupported detail. Revisit when exposing original-detail projection or accepting richer transformed payloads.
- **Ephemeral fork cache affinity:** [`bc5957eac9`](https://github.com/openai/codex/commit/bc5957eac9) shares parent cache affinity for ephemeral root forks while keeping metadata identities distinct. Ordinary child sessions remain distinct. Adopt only for an equivalent Pi workflow.
- **Tool-result metadata:** [`0df6366a87`](https://github.com/openai/codex/commit/0df6366a87) adds bounded metadata and destination filtering. Full Pi reconstruction intentionally loses provider-only tool metadata; widening it requires a durable host representation.
- **Compaction:** upstream removed legacy unary remote compaction ([`3dc1e2a584`](https://github.com/openai/codex/commit/3dc1e2a584), [`1ac689cc7d`](https://github.com/openai/codex/commit/1ac689cc7d)); this provider already uses streamed V2. Guardian producer-hash provenance ([`ad8ee16a5f`](https://github.com/openai/codex/commit/ad8ee16a5f)) remains outside the provider's checkpoint contract. Prompt retention before pre-turn compaction failure ([`ee93abb690`](https://github.com/openai/codex/commit/ee93abb690)) is a useful Pi lifecycle regression scenario.

## Code Mode and unaffected integrations

The latest stable release resolved through the official release API is [`rust-v0.154.0`](https://github.com/openai/codex/releases/tag/rust-v0.154.0), published September 9. The pre-existing local upgrade to that release and all six SHA-256 digests were preserved and rechecked. Its Code Mode host/runtime/protocol sources are unchanged from `0.153.4`. The real-host check passed on macOS arm64 for JavaScript output, nested shell execution, tool discovery, errors, yield/wait, and termination; other platforms were not executed.

Current `main` additionally scopes callback delegates to each execution ([`3305c4f31d`](https://github.com/openai/codex/commit/3305c4f31d)), retaining them across yields. This changes Rust ownership APIs, not the stdio request framing used here. The local [`delegate-runtime.ts`](../code-mode/delegate-runtime.ts) already keys tools and contexts by cell. At the next stable host upgrade, exercise concurrent cells and wait-time context updates to ensure execution ownership survives yields. No prerelease binary upgrade is needed for this review.

No relevant timer/clock delta or Plannotator manifest migration was identified. Codex's new rejection of plugin-supplied `ema_auth` does not affect the skills-only local Plannotator plugin.

## Validation

Validation passed on 2026-09-13: fixture regeneration and `--check`; all 683 subagents/provider unit tests; all 68 provider integration tests; the real Code Mode host check; package-scoped formatting/lint/type checks; repository package-readiness and README policy checks; and review-document local link resolution. The documentation test now distinguishes the historical behavior baseline from current extracted evidence. These checks validate the refreshed evidence and existing implementation; the recommended follow-ups remain unimplemented, and no inference canary was run.
