# Codex-quality provider replacement research

## Status and scope

This is the current research baseline for replacing Pi's complete effective `openai-codex` provider. The earlier [research report](research.md) remains a historical comparison of compaction extensions.

Research date: 2026-08-02

| Project | Revision inspected | Why |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | [`2b5bdcf67547860f2e5c5a605009a70026796b2b`](https://github.com/openai/codex/tree/2b5bdcf67547860f2e5c5a605009a70026796b2b) | Latest `main`, confirmed by both `git fetch` and the GitHub remote during this research |
| [earendil-works/pi](https://github.com/earendil-works/pi) | [`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/tree/845d6ff1f6643aba440341cce877ce1c43ebbc39) | Exact `v0.83.0` dependency used by this repository |

The review covered Codex's request client, Responses WebSocket and SSE transports, startup prewarm, remote compaction V2, history retention, model transitions, model catalog, context-window state, request metadata, and world state. It also covered Pi's provider composition, provider model/auth contracts, Responses serializer, extension lifecycle, and session-history APIs.

## Bottom line

A complete extension-owned Pi provider can reproduce most Codex behavior that occurs between Pi's finalized `Context` and the OpenAI Codex backend:

1. Request construction, Codex headers, canonical request metadata, event parsing, retries, and usage.
2. Physical WebSocket reuse, startup prewarm, exact delta-continuation eligibility, turn-sticky routing, and session-wide HTTP fallback.
3. Remote compaction V2 on the active turn session, Codex retention rules, context-window generations, and model compatibility transitions.
4. Remote model metadata refresh, including `comp_hash`, effective context limits, service tiers, reasoning defaults, and model-authored instructions.

Provider replacement cannot make Pi become the Codex application. Pi still owns the system prompt, tools, permissions, session entries, and agent lifecycle. The replacement must preserve Pi's exact effective prompt and tools rather than fabricate Codex-native world-state sections that Pi does not expose.

The largest remaining technical gap is durable history installation. Pi 0.83.0 does not expose an atomic operation that replaces arbitrary raw provider history and appends the corresponding persisted checkpoint. The existing fail-closed checkpoint and request-rewrite mechanism is still required.

## What current Codex does

### 1. One client session per user turn

Codex keeps a session-scoped `ModelClient` and creates a `ModelClientSession` for each user turn. That turn client is reused across normal tool-loop requests, retries, and inline remote V2 compaction. A cached physical WebSocket can survive across user turns, but turn-scoped routing state cannot ([client](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/client.rs)).

The distinction matters:

- **Session state:** cached WebSocket, last request/response for continuation, and permanent HTTP fallback after WebSocket retry exhaustion.
- **Turn state:** a fresh `x-codex-turn-state` token learned from the server and replayed only for later requests in the same user turn.
- **Request state:** the full previous request and completed response needed to prove that the next request is a strict input extension.

Codex can prewarm the first WebSocket with a `response.create` request whose `generate` field is `false`. The prewarm includes the initial instructions and tools, then returns the same client session for the first real turn ([startup prewarm](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session_startup_prewarm.rs)).

Continuation is deliberately strict. Every stable non-input request field must match, and the new input must equal the old input plus the completed response items followed by new input. Only then does Codex send the delta with `previous_response_id`. A mismatch sends the complete request on the same physical socket without continuation. Internal chat metadata is ignored when comparing otherwise equivalent input items.

The turn-state token can arrive in HTTP response headers, the WebSocket upgrade response, or WebSocket response metadata. Current Codex supports all three paths ([SSE transport](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/codex-api/src/sse/responses.rs), [WebSocket transport](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/codex-api/src/endpoint/responses_websocket.rs)).

### 2. Request shape and metadata are model-driven

Normal Responses requests include the finalized model input, base instructions, tools, tool policy, reasoning configuration, encrypted reasoning inclusion, service tier, session-derived prompt-cache key, text verbosity/schema, and client metadata. Azure and Responses Lite variants change several fields, so the serializer is not one fixed JSON template ([request builder](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/client.rs)).

Codex also builds a canonical metadata snapshot containing session, thread, turn, and context-window identities; request kind; thread provenance; sandbox/workspace state; tool mode; and compaction reason/phase/strategy. The canonical snapshot is sent in `client_metadata["x-codex-turn-metadata"]`, with selected legacy fields also projected into headers and flat metadata ([Responses metadata](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/responses_metadata.rs)).

We can send exact Pi and extension-owned values. We must omit Codex-native values that Pi cannot truthfully supply.

### 3. Remote V2 compaction is part of the turn client

Inline remote V2 compaction uses the active turn's `ModelClientSession`. Standalone manual compaction creates its own client session. The request is a normal streamed Responses request containing normalized history plus a trailing `compaction_trigger`; it is not `POST /responses/compact` ([attempt construction](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact_remote_v2_attempt.rs), [V2 orchestration](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact_remote_v2.rs)).

The client retries the stream at most twice, requires `response.completed`, and requires exactly one compaction output. It can compact using the previous model during a model transition and retry eligible failures with the current model.

After success, Codex reconstructs the window from recent real user messages, eligible non-final agent messages, and the opaque compaction item. Current retention behavior includes:

- A 64,000-token retained-input budget.
- Real user messages, truncated newest-first when necessary.
- Non-final agent messages only when their estimated size is at most 10,000 tokens.
- No final answer marked with `Message Type: FINAL_ANSWER`.
- No stale tool, reasoning, developer, or system items in the installed compacted history.

Fresh world-state context is inserted before the last eligible real user or non-final agent message, leaving the compaction item last ([retention and placement](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact_remote.rs)).

Inline compaction shares the same physical socket and turn-state token with its follow-up. It does **not** imply continuation from the compaction response. The compacted replacement history is normally not a strict extension of the compaction request, so Codex's generic eligibility test normally sends the full follow-up request without `previous_response_id`.

### 4. Model metadata controls quality behavior

Codex's `/models` response carries much more than a picker label. Relevant fields include model/base instructions, model-authored collaboration and permission messages, context and maximum window sizes, the auto-compaction limit, effective-window percentage, `comp_hash`, default reasoning effort, supported reasoning efforts, service tiers, text verbosity, tools/modalities, and Responses Lite support ([model schema](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/protocol/src/openai_models.rs)).

Codex refreshes `GET /models?client_version=...`, uses ETags, and normally treats cached entries as fresh for 300 seconds ([model manager](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/models-manager/src/manager.rs), [cache](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/models-manager/src/cache.rs), [endpoint](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/codex-api/src/endpoint/models.rs)). The default automatic compaction limit is 90% of the resolved context window.

Before sampling, Codex compacts when a model's non-empty `comp_hash` changes or when switching to a smaller model whose usable context is already exceeded. It records prior model settings so that it can compact with the previous model first ([turn transition](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/turn.rs)).

### 5. Context windows have explicit generations

Codex assigns UUIDv7 identities to the first, current, and previous context windows. It advances the window only after compaction is installed and sends the current identity in `x-codex-window-id` ([auto-compact window](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/state/auto_compact_window.rs)).

These identities do not replace history validation, but they let the backend and client correlate requests with the correct compacted generation. The extension can own and persist equivalent identities.

### 6. World state is a separate quality layer

Codex computes structured snapshots and diffs for model instructions, personality, token-budget guidance, realtime mode, repository instructions, permissions, collaboration mode, environment state, apps, plugins, deferred tools, extension contributions, and multi-agent mode ([session world state](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/world_state.rs), [world-state diffing](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/context/world_state/mod.rs)).

This is not purely a provider concern. Pi supplies its own effective system prompt, tools, context files, skills, permissions, and messages. The replacement can preserve that exact state and track extension-owned changes, but it cannot reconstruct unavailable Codex application state from the API.

## What Pi 0.83.0 lets the extension own

Pi can register a complete `Provider` object for `openai-codex`. That object becomes the base provider and can own identity, model listing/refresh, auth delegation, and both stream methods. Pi's provider factory is publicly importable, so the replacement can reuse its ChatGPT OAuth implementation and static model fallback rather than cloning login behavior ([provider composition](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/provider-composer.ts), [built-in provider](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/providers/openai-codex.ts)).

The dynamic model refresh context exposes the refreshed OAuth credential, a provider-scoped persistent model store, network policy, force-refresh state, and cancellation. The provider can therefore call Codex's model endpoint without owning credential refresh. Pi's `Model` type cannot represent all Codex fields, so the full Codex metadata needs a provider-private side map while the compatible projection populates Pi's model list.

Pi's public Responses serializer already converts the finalized `Context` and tool definitions, including reasoning items, images, function/custom tools, tool results, and deferred tools. Reusing it avoids a second Pi-to-Responses converter ([shared Responses serializer](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/api/openai-responses-shared.ts)).

The provider receives the exact finalized context and resolved request options. Extension lifecycle hooks can coordinate user-turn boundaries, model changes, compaction, and durable checkpoints. The stream implementation must continue to honor Pi's payload, response, cancellation, retry, and header contracts.

## Parity boundary

| Capability | Expected parity | Reason |
| --- | --- | --- |
| Request body, headers, metadata, events, usage | Full | Owned after Pi finalizes `Context` |
| WebSocket/SSE lifecycle, prewarm, continuation, turn state, fallback | Full | Provider-private transport state |
| Remote V2 request and retention algorithm | Full | Provider and extension jointly own compaction flow |
| Model metadata, `comp_hash`, limits, service tiers | Full when the model endpoint is available | OAuth credential and refresh hook are available |
| Pi prompt, tools, and live message state | Full Pi fidelity | Exact values are exposed to the provider |
| Codex-native world state | Partial | Several Codex application sections have no Pi equivalent |
| Durable arbitrary replacement history | Partial | Pi compaction entries cannot atomically store raw provider history |
| Resume and process restart | Durable full-request recovery | Server continuation and sockets are intentionally ephemeral |
| Backend attestation and private server behavior | Unavailable unless exposed | An extension cannot manufacture backend-only state |

## Changes from the historical research baseline

The current source adds or clarifies several details that affect the replacement plan:

1. `x-codex-turn-state` is explicitly turn-scoped and supported by both SSE and WebSocket event paths.
2. Startup WebSocket prewarm and exhaustive continuation eligibility are part of the normal client lifecycle.
3. Canonical Responses metadata and context-window IDs are first-class request state.
4. Remote V2 retention now includes bounded non-final agent messages, with fresh-context placement updated accordingly.
5. Model metadata and world-state sections now carry more quality-relevant behavior than Pi's static model catalog can express.

## Implications for this extension

- Replace the complete effective provider, but delegate authentication and the static fallback catalog to Pi's built-in `openai-codex` provider.
- Reuse Pi's public Responses serializers and existing checkpoint validation; do not build parallel abstractions for either.
- Move V2 compaction into the provider's active turn session, while retaining fail-closed durable checkpoint installation through Pi's hooks.
- Treat continuation as an optimization with exact eligibility, not as the source of correctness. Recovery always uses the complete durable history.
- Keep Pi's effective prompt and tools authoritative. Add only metadata and world-state values that can be sourced exactly.
