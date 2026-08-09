# Codex source baseline

This is the current source map for the behavior implemented by `codex-provider`. OpenAI Codex is the parity authority; Pi defines the host boundary.

## Verified revisions

| Project | Revision | Verification |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | [`9873cba8ce6d14e650e12cdc0dddd159ae6613d7`](https://github.com/openai/codex/tree/9873cba8ce6d14e650e12cdc0dddd159ae6613d7), committed 2026-08-04 08:51:35 UTC | Verified against `origin/main` on 2026-08-04 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | [`a5f43bf8aff3c55752432655f7334e3dafd1e256`](https://github.com/earendil-works/pi/tree/a5f43bf8aff3c55752432655f7334e3dafd1e256), tag `v0.84.0` | Exact supported host revision |

At this revision, model instructions live under `ModelMessages`, plugin instructions are gated by model capability, and compact permission state is part of application world state. Those features remain on the application side of the boundary described below; the provider mapping covers request construction, transport, prewarm, continuation, compaction, window state, and Responses metadata.

## Codex source map

| Behavior | Codex source | Local implementation and proof |
| --- | --- | --- |
| Turn-scoped client session, request construction, strict continuation, retries | [`core/src/client.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/client.rs) | [`provider.ts`](../provider.ts), [provider tests](../tests/provider.test.ts) |
| Startup WebSocket prewarm | [`core/src/session_startup_prewarm.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session_startup_prewarm.rs) | [`provider.ts`](../provider.ts), [lifecycle integration tests](../tests/lifecycle.integration.test.ts) |
| SSE response headers and turn state | [`codex-api/src/sse/responses.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/codex-api/src/sse/responses.rs) | [`provider.ts`](../provider.ts), [provider tests](../tests/provider.test.ts) |
| Reusable WebSocket, metadata, continuation, protocol retry | [`codex-api/src/endpoint/responses_websocket.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/codex-api/src/endpoint/responses_websocket.rs) | [`provider.ts`](../provider.ts), [provider tests](../tests/provider.test.ts), [live canary](live-canary.md) |
| Canonical turn/window/compaction metadata | [`core/src/responses_metadata.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/responses_metadata.rs) | [`provider.ts`](../provider.ts), [provider tests](../tests/provider.test.ts) |
| Remote V2 request and stream validation | [`core/src/compact_remote_v2_attempt.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/compact_remote_v2_attempt.rs), [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/compact_remote_v2.rs) | [`provider.ts`](../provider.ts), [`lifecycle.ts`](../lifecycle.ts), [provider tests](../tests/provider.test.ts) |
| Retained users, non-final agents, and fresh-context placement | [`core/src/compact_remote.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/compact_remote.rs) | [`replay.ts`](../replay.ts), [replay tests](../tests/replay.test.ts) |
| Pre-turn model transition compaction | [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/turn.rs) | [`lifecycle.ts`](../lifecycle.ts), [lifecycle integration tests](../tests/lifecycle.integration.test.ts) |
| Context-window IDs and generations | [`core/src/state/auto_compact_window.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/state/auto_compact_window.rs) | [`provider.ts`](../provider.ts), [`checkpoint.ts`](../checkpoint.ts), [checkpoint tests](../tests/checkpoint.test.ts) |
| Model metadata schema and instruction compatibility | [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/protocol/src/openai_models.rs) | [`provider.ts`](../provider.ts), [provider model-refresh tests](../tests/provider.test.ts) |
| Model refresh, ETags, and cache age | [`models-manager/src/manager.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/models-manager/src/manager.rs), [`cache.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/models-manager/src/cache.rs), [`codex-api/src/endpoint/models.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/codex-api/src/endpoint/models.rs) | [`provider.ts`](../provider.ts), [provider model-refresh tests](../tests/provider.test.ts) |
| Application world-state snapshots and diffs | [`core/src/session/world_state.rs`](https://github.com/openai/codex/blob/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/session/world_state.rs), [`core/src/context/world_state/`](https://github.com/openai/codex/tree/9873cba8ce6d14e650e12cdc0dddd159ae6613d7/codex-rs/core/src/context/world_state) | Deliberate boundary: preserve Pi's effective prompt/tools; do not synthesize unavailable Codex application state |

## Pi 0.84.0 source map

| Host contract | Pi source | Local use |
| --- | --- | --- |
| Complete provider composition and auth delegation | [`provider-composer.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/provider-composer.ts), [`openai-codex.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/ai/src/providers/openai-codex.ts) | Register the complete provider while reusing Pi's OAuth and static fallback catalog |
| Responses message/tool serialization and event processing | [`openai-responses-shared.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/ai/src/api/openai-responses-shared.ts) | Reuse public converters instead of maintaining a parallel Pi adapter |
| Hook chaining and provider registration | [`extensions/runner.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/extensions/runner.ts), [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/extensions/types.ts) | Pair context, headers, finalized payload, compaction, and persisted entries; require audited load-last order |
| Manual, threshold, and overflow compaction lifecycle | [`agent-session.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/agent-session.ts), [`compaction.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/compaction/compaction.ts) | Run readable and native lifecycle compaction together; preserve Pi overflow retry semantics |
| Branch persistence and active history | [`session-manager.ts`](https://github.com/earendil-works/pi/blob/a5f43bf8aff3c55752432655f7334e3dafd1e256/packages/coding-agent/src/core/session-manager.ts) | Resolve the newest active checkpoint and verify every append against the active branch |

## Implemented mapping

The local provider mirrors the parts of Codex that occur after Pi has finalized `Context`:

1. Model-driven request fields, Codex headers, truthful canonical session/turn/window metadata, event parsing, usage, fast-mode selection, and service-tier pricing.
2. Cached WebSocket transport, turn-state propagation, startup prewarm, exact delta continuation, protocol retries before visible output, and session-sticky SSE fallback.
3. Remote V2 compaction on the active turn session, bounded private-stream retries, 64,000-token retained input, non-final agent retention, tool-history repair, model transitions, and explicit window generations.
4. `/models` refresh with a five-minute freshness window, ETag revalidation, a provider-private metadata map, and a Pi-compatible projected model catalog.
5. Strict checkpoint v1 persistence, active-branch replay, readable lifecycle summaries, resume/fork recovery, and redacted diagnostics.

The behavior is exercised by [unit and contract tests](../tests), [real `AgentSession` tests](../tests/lifecycle.integration.test.ts), package smoke coverage, and the opt-in [live canary](live-canary.md).

## Intentional gaps and divergences

- **Pi is the application authority.** The provider sends Pi's actual prompt, tools, permissions, skills-derived context, and messages. It does not fabricate Codex personalities, collaboration messages, permission snapshots, apps/plugins state, environment diffs, deferred-tool world state, or extension contributions that Pi does not expose as provider input.
- **Metadata is truthful rather than exhaustive.** Session, thread, turn, request kind, compaction, and window values are sent when locally owned. Codex-native provenance, sandbox, workspace, tool-mode, and application fields are omitted when no exact Pi value exists.
- **Durable installation is verified, not atomic.** Pi has no transaction that replaces raw provider history and appends a checkpoint. The extension verifies append and request continuation separately and aborts on any stale or unverifiable state.
- **Resume favors full durable requests.** Sockets, turn state, and `previous_response_id` are performance state only. A fresh process rebuilds the complete request from checkpoint v1 plus the active Pi branch.
- **Images are transient.** Durable retained images become text omissions. This avoids replaying stale image bytes and the retained-image failure tracked in [openai/codex#24388](https://github.com/openai/codex/issues/24388).
- **Token counts are conservative estimates.** UTF-8 bytes divided by four plus a fixed image estimate drive local thresholds and retention. No tokenizer dependency or fixed 372,000-token override is used without live evidence.
- **Visible-stream retries stay outside the provider.** The provider never retracts emitted deltas. Pi's outer retry handles post-emission failures; private compaction streams can retry because their partial output is not user-visible.
- **Portable summaries are a Pi adaptation.** Lifecycle compaction pays for and persists a readable Pi summary beside the opaque item so incompatible providers and exports remain usable. Compatible Codex requests still receive only the opaque replacement.
- **Rollout-budget accounting is not implemented.** Current Codex consumes `usage.codex_rollout_budget_units` for application policy. Pi's `Usage` cannot represent it and this provider owns no rollout-budget policy.
- **Backend-only behavior is not claimed.** Server attestation, private routing, and unavailable backend state cannot be reproduced by an extension.

These boundaries are acceptance criteria, not future scaffolding. Change one only when a concrete Pi/Codex source change or failing canary proves it necessary.
