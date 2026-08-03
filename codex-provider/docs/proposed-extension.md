# Proposed standalone Pi extension: Codex remote compaction V2

> Historical pre-implementation proposal. It contains superseded designs, including durable image retention, and does not describe private checkpoint v4. See [design.md](design.md) for current behavior.

## Decision

Build one package, `@clanker-extensions/codex-provider`, that:

1. Activates only for `provider === "openai-codex"` and `api === "openai-codex-responses"`.
2. Leaves ordinary model calls on Pi's registered provider and changes only the finalized Responses `input` in `before_provider_request`.
3. Executes compaction through that same registered provider's `streamSimple()`, with the same model, auth resolution, session ID, instructions, tools, reasoning, cache key, and request envelope.
4. Appends exactly one `{ type: "compaction_trigger" }` to the compaction request, captures the raw completed opaque item by teeing the provider's SSE `Response`, and installs `recent real user messages + one compaction item` as the replacement window.
5. Persists the replacement window in Pi session entries and reconstructs it on every active branch replay. It never persists auth, the full request, or response headers.

This is the closest safe standalone architecture available in Pi 0.83.0. It deliberately does **not** register or override a provider, implement a second Responses serializer, or own the HTTP request. The only wire-level code is a small SSE observer around a cloned `Response`; Pi's provider still owns URL construction, auth/account headers, request compression, status handling, usage mapping, and the original response stream.

The extension can reach the **Works** acceptance level below. The **Codex-quality** level requires Pi core APIs that do not exist yet.

---

## 1. Source baseline

All upstream claims in this design are pinned to these revisions. Line ranges are included so implementation does not accidentally follow a newer checkout.

### OpenAI Codex

- **C1 — V2 request construction.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/compact_remote_v2_attempt.rs:30-134`; [GitHub at `6219b7c40fc9c702c0aef9964e72b492558f60e4`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2_attempt.rs#L30-L134).
- **C2 — output validation, installation, retention, and truncation.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/compact_remote_v2.rs:201-572`; [GitHub at `6219b7c40f`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L201-L572).
- **C3 — pre-sampling and mid-tool-loop timing.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/session/turn.rs:139-183,264-461,985-1014`; [GitHub at `6219b7c40f`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L139-L183) and [mid-turn loop](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L264-L461).
- **C4 — 90% automatic threshold and effective context window.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/protocol/src/openai_models.rs:409-470` and `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/session/turn_context.rs:220-227`; [threshold](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/protocol/src/openai_models.rs#L409-L470) and [effective window](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn_context.rs#L220-L227).
- **C5 — tool-history reconciliation and trailing-output shrink.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/context_manager/normalize.rs:20-219` and `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/compact_remote.rs:365-465`; [normalization](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/context_manager/normalize.rs#L20-L219) and [shrink](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote.rs#L365-L465).
- **C6 — request metadata, beta feature, and turn-scoped transport state.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/client.rs:303-359,482-498,1887-1911`, `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/responses_metadata.rs:27-176`, and `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/session/mod.rs:998-1020`; [client](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/client.rs#L303-L359), [metadata](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/responses_metadata.rs#L27-L176), and [feature header](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/mod.rs#L998-L1020).
- **C7 — history replacement and fresh world-state injection.** Local: `/Users/gg/.cache/checkouts/github.com/openai/codex/codex-rs/core/src/compact_remote.rs:302-363`; [GitHub at `6219b7c40f`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote.rs#L302-L363).

### Pi 0.83.0

- **P1 — public hooks and extension context.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts:307-347,591-696,1112-1213,1275-1323`; [GitHub at `845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/types.ts#L307-L347).
- **P2 — registered provider and auth resolution.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/model-registry.ts:44-139`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/model-registry.ts#L44-L139).
- **P3 — public stream callbacks.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/ai/src/types.ts:100-177,220-324`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/types.ts#L100-L177).
- **P4 — Codex provider request serialization and transport order.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/ai/src/api/openai-codex-responses.ts:270-499,529-595,721-819,1374-1525`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/api/openai-codex-responses.ts#L270-L499).
- **P5 — hook chaining catches handler errors.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/extensions/runner.ts:796-827,979-1074`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/extensions/runner.ts#L979-L1074).
- **P6 — compaction loop, stale-usage guard, overflow retry, and persistence.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/agent-session.ts:1778-2215,3164-3208`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L1778-L2215).
- **P7 — branch replay and context-visible versus custom entries.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/session-manager.ts:316-470`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/session-manager.ts#L316-L470).
- **P8 — shared Responses serializer.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/ai/src/api/openai-responses-shared.ts:136-379`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/api/openai-responses-shared.ts#L136-L379).
- **P9 — coding-agent wiring of context, payload, headers, response, and session ID.** Local: `/Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/sdk.ts:292-360`; [GitHub at `845d6ff1`](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/sdk.ts#L292-L360).

The installed runtime inspected for this design is `/Users/gg/.local/share/fnm/node-versions/v26.5.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/package.json` at version 0.83.0. Phase 0 subsequently verified that the repository workspace, installed packages, and lockfile all resolve `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 0.83.0. See `/Users/gg/code/priv/clanker-extensions/codex-provider/docs/spike-results.md`.

### Prior Pi adapter used only as a comparative check

- **H1 — registered-stream approach and finalized replay rewrite.** Local pinned content was read with `git show 7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988:...`, not from its newer working tree: `/Users/gg/.cache/checkouts/github.com/IgorWarzocha/howaboua-pi-stuff/packages/pi-codex-conversion/src/adapter/compaction/remote-v2-client.ts:38-157` and `/Users/gg/.cache/checkouts/github.com/IgorWarzocha/howaboua-pi-stuff/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts:298-325`; [client at the pinned revision](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/remote-v2-client.ts#L38-L157) and [rewrite](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L298-L325).

---

## 2. Fidelity target

Codex V2 performs compaction as an ordinary streaming Responses request: it clones normalized history, shrinks only a contiguous trailing run of tool outputs if necessary, appends a trigger, and uses the normal model stream [C1, C5]. It accepts additional completed output items but requires exactly one valid `compaction` output and a terminal completed response [C2].

After success, Codex installs:

```text
newest retained real-user messages within ~64K tokens
+ exactly one new opaque compaction item
```

The previous opaque item, assistant items, reasoning, calls, outputs, developer/system/contextual-user messages, and the trigger are not installed. The boundary message may be middle-truncated, images are preserved, and an image-only message consumes at least one budget token [C2]. This replacement is atomic in Codex, followed by world-state reinjection and token recomputation [C2, C7].

Codex checks compaction before normal sampling and after a response when the tool loop needs another sample. Its default automatic limit is at most 90% of the model context; request fit uses the model's effective context window, normally 95% of its resolved window [C3, C4].

The proposed extension matches the request control, retained-window shape, active-branch replay, pre-request timing, and tool-loop timing. It cannot match Codex's atomic rollout mutation, world-state model, exact token accounting, turn metadata, or turn-scoped cached-WebSocket continuation.

---

## 3. Architecture

### 3.1 Normal provider requests stay normal

Pi already runs `context`, converts messages, builds the provider payload, invokes `before_provider_request`, assembles headers, and consumes the provider response [P4, P9]. The extension must not replace that lane.

For ordinary calls:

1. `context` inserts private, per-request boundary sentinels only when replay is active or usage is at the compaction threshold.
2. `before_provider_request` locates those sentinels in the finalized Responses `input`, removes them, and either:
   - restores the persisted opaque checkpoint before the live tail; or
   - runs inline compaction and substitutes the new replacement window.
3. `before_provider_headers` merges `remote_compaction_v2` into `x-codex-beta-features` without replacing other feature values. Current Codex advertises the feature session-wide [C6].
4. The built-in provider then owns normal SSE/WebSocket selection, prompt-cache key, account header, compression, retries, response parsing, and cached continuation [P4].

No sentinel may reach the server. Missing, duplicated, malformed, or out-of-order sentinels are a fail-closed condition when a checkpoint is active.

### 3.2 Compaction uses the registered provider

Resolve at attempt time:

```ts
const provider = ctx.modelRegistry.getProvider(ctx.model.provider);
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
const stream = provider?.streamSimple(ctx.model, context, options);
```

These are public Pi APIs [P2, P3]. Do not import Pi's built-in Codex provider directly and do not register a shadow provider.

The compaction `Context` uses:

- `systemPrompt: ctx.getSystemPrompt()`;
- the active effective history or live tail;
- active tools projected from `pi.getAllTools()` filtered by `pi.getActiveTools()`;
- the current model and `pi.getThinkingLevel()`.

`onPayload` receives the provider-built request. It preserves the envelope and changes only:

```ts
{
  ...body,
  input: [...normalizedAndShrunkInput, { type: "compaction_trigger" }]
}
```

For inline compaction, use the already-observed normal request envelope as the authoritative envelope. For lifecycle compaction, use the registered provider-built envelope and, when available, copy only non-history request fields from the last observed normal envelope after verifying model and session identity. Never persist that envelope.

This preserves `model`, `instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `text`, `service_tier`, `store`, `stream`, `include`, `prompt_cache_key`, and `client_metadata` exactly for inline attempts. This mirrors Codex's reuse of the normal stream and request settings [C1, C6].

### 3.3 Raw opaque output capture

Pi 0.83.0 exposes `fetch`, `onPayload`, and `onResponse`, but no public raw `response.output_item.done` callback; the shared parser also intentionally ignores unknown compaction items [P3, P8]. Therefore:

1. Force the compaction side request to `transport: "sse"`.
2. Supply a `fetch` wrapper that calls `globalThis.fetch` with the exact provider-supplied arguments.
3. Immediately call `response.clone()`.
4. Return the original `Response` untouched to Pi's provider.
5. Parse only SSE framing and JSON from the clone, collecting `response.output_item.done`, `response.completed`/`response.done`, and terminal error events.
6. Cancel the clone reader after the terminal event or on abort.

This is an observer, not a direct HTTP client. It does not construct a URL, headers, body, compression, or status policy. `fetch` does not apply to WebSocket transports, which is why the side request must be SSE [P3, P4].

Success requires all of:

- HTTP status is successful;
- Pi's provider stream ends normally with `stopReason === "stop"`;
- raw SSE reaches a completed terminal event with a response ID;
- exactly one completed output item canonicalizes to `type: "compaction"`;
- `encrypted_content` is a non-empty string;
- optional `id` and `internal_chat_message_metadata_passthrough.turn_id` have valid types.

Accept `compaction_summary` only as an input alias and store it canonically as `compaction`. Ignore additional non-compaction output items, matching current Codex [C2]. Never synthesize an opaque item from Pi's assistant message.

### 3.4 Why the other architectures are rejected

| Rejected route | Reason |
| --- | --- |
| Direct HTTP/SSE client | Duplicates endpoint, auth/account headers, compression, proxy behavior, cache/session affinity, request options, and error mapping already owned by Pi. |
| Shadow/custom provider | Changes normal provider ownership and risks divergence in tools, reasoning, model compatibility, retries, and WebSocket behavior. |
| Second Responses serializer | Pi already exposes and uses the shared serializer; a fork would drift on IDs, grammar/custom tools, images, and cross-model history [P8]. |
| Lifecycle hook only | Misses pre-sampling and between-tool-call compaction, both real Codex timings [C3]. |
| Payload rewrite without context boundaries | Cannot reliably distinguish Pi history from fresh messages injected by other `context` handlers. |

---

## 4. Hook plan

Register exactly these hooks:

| Pi hook | Responsibility |
| --- | --- |
| `session_start` | Reset ephemeral state and validate the latest active checkpoint on the selected branch. |
| `session_shutdown` | Abort a side request, clear status, and invalidate captured context. |
| `model_select` | Invalidate cached envelope/token data; re-resolve checkpoint compatibility. |
| `context` | Build the per-request replay frame and insert start/end sentinels. |
| `before_provider_request` | Validate the finalized Responses payload, restore replay, decide threshold compaction, run an inline side request, and return the replacement payload. |
| `before_provider_headers` | Merge `remote_compaction_v2` into the beta-feature header for supported normal requests. |
| `session_before_compact` | Replace Pi manual, threshold, and overflow compaction with remote V2. |
| `session_compact` | Verify that lifecycle installation produced a branch-resolvable checkpoint and clear transient state. |

Do not register a command: Pi's `/compact` already reaches `session_before_compact`. Do not register a configuration system in v1; the 90%, 95%, and 64K values are fidelity constants, not user preferences.

If `/compact` supplies custom instructions, show one warning and ignore them. V2 sends active instructions and has no custom summary prompt [C1].

### Handler ordering requirement

Install this extension last among extensions that mutate `context`, `before_provider_request`, `before_provider_headers`, or `session_before_compact`.

Pi chains handlers in extension order and catches their exceptions [P5]. Consequences:

- a later payload handler could remove the checkpoint after this extension validates it;
- a later context handler could insert content inside the sentinels;
- a later compaction handler could overwrite this handler's result;
- throwing from `before_provider_request` does not by itself block a request.

This is a documented runtime requirement, not something the extension can detect reliably through public APIs. On a fail-closed path, call `ctx.abort()` before returning/throwing. Phase 0 must prove that the resulting aborted signal prevents the provider fetch; Pi's built-in provider checks the signal before the HTTP attempt [P4, P5].

---

## 5. Per-session state machine

Use one closure-owned state object. Do not use a generic mutex abstraction.

```text
READY
  ├─ context threshold/replay ─> FRAMED
  ├─ lifecycle compaction ─────> COMPACTING
  └─ session shutdown ─────────> CLOSED

FRAMED
  ├─ valid provider payload ───> REPLAYING
  ├─ threshold reached ────────> COMPACTING
  └─ mismatch/abort ───────────> READY (request aborted if checkpoint active)

COMPACTING
  ├─ valid terminal output ────> INSTALLING
  ├─ retryable failure ────────> COMPACTING (maximum two retries)
  └─ final failure/abort ──────> READY

INSTALLING
  ├─ branch/model/source match ─> READY
  └─ stale or persist failure ──> READY (discard result; abort pending request)
```

State fields:

```ts
type RuntimeState = {
  generation: number;
  phase: "ready" | "framed" | "compacting" | "installing" | "closed";
  inFlight?: Promise<AttemptResult>;
  frame?: RequestFrame;
  lastEnvelope?: ResponsesEnvelope;
  lastFailureSourceHash?: string;
  notified: Set<string>;
};
```

`generation` increments on session start/replacement, shutdown, and model selection. Every async attempt captures:

- generation;
- session ID;
- current leaf ID;
- provider/API/model/base URL identity;
- source-input SHA-256;
- trigger reason and phase;
- abort signal.

Before installation, all captured values except session ID on a legitimate fork must still match. The branch leaf must be unchanged. If any check fails, discard the response and persist nothing.

There is at most one side request per session. A second caller awaits the same promise only if its source hash is identical; otherwise it aborts as stale. The direct provider stream bypasses Pi's extension runner, so it cannot recurse through `before_provider_request`; retain the `phase === "compacting"` guard as an invariant assertion.

Automatic compaction is skipped when the effective input hash equals the active checkpoint's `replacementSha256` and there is no live tail. This avoids recompacting an unchanged opaque item. Manual compaction may still do so.

---

## 6. Request framing and finalized replay

### 6.1 Build a frame in `context`

Resolve Pi's baseline context from the active branch using public `buildSessionContext()`/`sessionEntryToContextMessages()` behavior [P7]. Find that exact message sequence exactly once as a contiguous subsequence of `event.messages`.

Messages outside the match are fresh mutations from earlier context handlers:

```text
event.messages = freshPrefix + piBaseline + freshSuffix
```

When no native checkpoint is active and usage is below 90%, return nothing and do not frame the request. This keeps ordinary requests byte-for-byte owned by Pi.

At the threshold:

```text
freshPrefix + START(nonce) + piBaseline + END(nonce) + freshSuffix
```

With an active checkpoint:

```text
freshPrefix + START(nonce) + liveTailAfterCheckpoint + END(nonce) + freshSuffix
```

Use random UUIDv7 nonces and exact structured marker text. Markers are hidden, ephemeral user messages and are never appended to the session.

If the baseline cannot be matched:

- no active checkpoint: do not alter context; defer to Pi lifecycle/overflow recovery;
- active inline checkpoint: call `ctx.abort()`, notify once, and do not permit a provider request;
- active lifecycle checkpoint: same fail-closed behavior, because Pi's visible summary is only a marker and is not a safe replacement for encrypted state.

### 6.2 Rewrite in `before_provider_request`

Require a strict Responses object:

- object, not array;
- `input` is an array;
- `model` is the current model ID;
- `stream === true`;
- `store === false`;
- no preexisting `compaction_trigger`;
- current provider/API/model identity still matches the frame.

Find the serialized start and end markers exactly once and in order. Split:

```text
prefixInput + START + framedInput + END + suffixInput
```

Then:

```text
no checkpoint:
  effectiveInput = prefixInput + framedInput + suffixInput

active checkpoint:
  effectiveInput =
    prefixInput + checkpoint.replacement + framedInput + suffixInput
```

On replay without compaction, return the original payload with only `input: effectiveInput`. The opaque replacement is inserted once; old opaque checkpoints and Pi's placeholder compaction summary are removed with the framed baseline.

For inline compaction, send all of `effectiveInput` to the side request, but install only the checkpoint replacement. The pending normal request becomes:

```text
prefixInput + newCheckpoint.replacement + suffixInput
```

This preserves fresh authoritative context around the compacted conversation, which is the closest public-API analogue to Codex world-state reinjection [C7].

### 6.3 Marker side effect

Markers pass through Pi's message serializer before removal, so they can shift fallback-generated assistant item IDs in a framed request. Framing occurs only at a threshold or while replaying a checkpoint, never in ordinary below-limit requests. Most same-provider assistant items already carry server IDs.

Eliminating this difference requires either:

- a public finalized-payload segment map; or
- a provider serializer that accepts opaque history items directly.

It is a known **Works** limitation and a **Codex-quality** blocker.

---

## 7. Checkpoint format and active-branch semantics

### 7.1 Strict persisted schema

Use custom type `codex-compaction.checkpoint`. The first schema version is 1; “V2” describes OpenAI's compaction protocol, not this storage version.

```ts
type CheckpointV1 = {
  schema: "clanker.codex-compaction/checkpoint";
  version: 1;
  protocol: "openai-responses-compaction-v2";

  identity: {
    provider: "openai-codex";
    api: "openai-codex-responses";
    model: string;
    baseUrl: string | null;
    originSessionId: string;
  };

  createdAt: string;
  reason: "manual" | "threshold" | "overflow";
  phase: "standalone" | "pre-sampling" | "mid-turn" | "overflow-retry";

  response: {
    id: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  };

  replacement: Array<RealUserInputItem | CanonicalCompactionItem>;

  integrity: {
    sourceSha256: string;
    replacementSha256: string;
    estimatedSourceTokens: number;
    rewrittenTrailingOutputs: number;
  };

  policy: {
    retainedUserTokens: 64000;
    autoCompactPercent: 90;
    effectiveContextPercent: 95;
  };
};
```

Validation is strict:

- reject unknown top-level keys and non-finite/negative numbers;
- require valid ISO timestamps and lowercase 64-hex SHA-256 values;
- allow replacement messages only with `role: "user"`, `type: "message"`, and `input_text`/`input_image` content;
- require exactly one canonical compaction item, last;
- reject trigger, assistant, reasoning, tool, developer, and system items;
- reject empty encrypted content;
- preserve only recognized metadata fields.

Integrity hashes detect corruption and stale calculations; they are not an authentication mechanism.

Do not persist:

- API key, OAuth token, account ID, or auth-derived hashes;
- request headers or `client_metadata`;
- full source history or system prompt;
- raw SSE events or non-compaction output items;
- error bodies.

### 7.2 Two persistence carriers

**Inline success**

```ts
pi.appendEntry("codex-compaction.checkpoint", checkpoint);
```

Custom entries persist but do not participate in LLM context [P1, P7]. After append, re-read the leaf and assert that the new leaf is the expected custom entry before returning the rewritten normal payload.

**Pi lifecycle success**

Return:

```ts
{
  compaction: {
    summary: "[OpenAI encrypted compaction checkpoint]",
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage: providerUsage,
    details: {
      type: "codex-compaction.checkpoint",
      checkpoint
    }
  }
}
```

Pi persists `details`, reloads agent context, and records lifecycle compaction usage in session totals [P6]. The summary is only a local marker; active replay must remove it before any provider request.

Inline side-request usage cannot be added to Pi's built-in session totals through public APIs. Keep it in checkpoint details and the custom renderer.

### 7.3 Resolve the active checkpoint

Walk only `ctx.sessionManager.getBranch()`, never all entries.

Treat these as ordered compaction boundaries:

1. a custom entry with custom type `codex-compaction.checkpoint`;
2. any Pi `compaction` entry.

The last boundary wins:

- if it is a valid checkpoint custom entry, that checkpoint is active;
- if it is a Pi compaction whose `details` contains a valid checkpoint, that checkpoint is active;
- if it is any other Pi compaction, all earlier native checkpoints are inactive.

This prevents replaying a checkpoint from an abandoned branch or through a newer Pi fallback compaction. An old opaque checkpoint is never nested into a new one; a successful new checkpoint replaces it.

Tail entries are strictly those after the active boundary on the selected branch, projected with Pi's normal session-entry conversion. Never use timestamps as the primary boundary.

### 7.4 Resume, fork, corruption, and model changes

- Resume: validate and replay the active checkpoint from session data.
- Fork after the checkpoint: replay is allowed even though the new Pi session ID differs; keep the origin ID for audit only.
- Fork before the checkpoint: it is absent from the branch and therefore inactive.
- Unknown schema version: never scan backward to an older checkpoint.
- Corrupt inline checkpoint: ignore it and use intact local Pi history.
- Corrupt lifecycle checkpoint: abort provider requests; its summarized history is no longer recoverable from active Pi context.
- Provider/API/base URL mismatch: never send the opaque item.
- Model mismatch after an inline checkpoint: use intact local Pi history.
- Model mismatch after a lifecycle checkpoint: abort and instruct the user to restore the original model or branch before the checkpoint.

Codex can use `comp_hash` to decide model compatibility; Pi does not expose it [C3]. Exact-model replay is intentionally conservative.

### 7.5 Migration policy

There is no preexisting standalone schema to migrate. Implement a pure `parseAndMigrateCheckpoint(unknown)` dispatcher now:

```text
version 1 -> strict validation -> immutable CheckpointV1
other     -> unsupported-version result
```

Do not add speculative v0 aliases. A future version must add a pure `vN -> vN+1` migration with fixture tests and must never rewrite old session entries in place; upgraded data is written only on the next successful compaction.

---

## 8. V2 history construction

### 8.1 Effective compaction input

Before sending:

1. Start with the finalized effective input, including the active replacement, live tail, and fresh prefix/suffix.
2. Remove orphan tool outputs.
3. Insert deterministic `"aborted"` outputs immediately after missing function, custom-tool, local-shell, and client tool-search calls.
4. Strip unsupported image/audio inputs using the active model's advertised modalities.
5. Estimate `instructions + input`.
6. If over the effective 95% request budget, rewrite only the contiguous trailing run of recognized tool outputs, newest first.
7. Append exactly one trigger after normalization and shrinking.

Codex performs prompt normalization before adding the trigger [C1, C5].

Synthetic output IDs should match Codex's deterministic UUIDv5 construction: namespace `90d38d3e-6a5b-4d52-bfe2-2f1e634bfac4`, name `"<prefix>:<source item id>"`, and output ID `"<prefix>_<uuid>"`. Use `node:crypto` SHA-1; add no UUID dependency [C5].

Trailing replacements preserve IDs, call IDs, status, execution, metadata, and success state:

- function/custom output body becomes `"Output exceeded the available model context and was truncated"`;
- client `tool_search_output.tools` becomes `[]`.

Stop at the first non-output item even if the request remains oversized. The estimate is coarse, so send it and let the provider make the authoritative decision, matching Codex [C5].

### 8.2 Token estimation

Use a model-visible UTF-8 byte estimator with ceiling division by four:

- JSON text and item structure count by UTF-8 bytes;
- image URLs do not count at base64 length; use a fixed image estimate;
- count instructions;
- use saturating arithmetic;
- treat non-finite model windows as unavailable.

Use `floor(model.contextWindow * 0.90)` for automatic compaction and `floor(model.contextWindow * 0.95)` for request shrinking. These are the closest values available from Pi model metadata [C4].

For triggering:

1. Prefer `ctx.getContextUsage().tokens` only when it comes from a successful assistant after the active checkpoint.
2. Otherwise use the finalized effective-input estimator.
3. Never use a pre-checkpoint assistant usage value.
4. Trigger at `>=`, not `>`.

Pi's own threshold is `contextWindow - reserveTokens`, not Codex's 90% rule [P6]. If Pi fires first, `session_before_compact` handles it. If this extension fires first, inline compaction prevents Pi's later summarization.

### 8.3 Retained replacement window

Eligible retained items are only raw input items corresponding to actual Pi `SessionMessageEntry` user messages on the active branch:

- for an existing native replacement, its retained user items remain eligible;
- add actual user entries after the native boundary;
- exclude Pi custom messages, bash projections, branch/compaction summaries, contextual injections, developer/system items, and heuristic text matches.

Use Pi's shared `convertResponsesMessages()` only to identify the raw serialization of an actual user message [P8]. Match candidates in order inside the effective input, then canonicalize retained Pi items to `{ type: "message", role: "user", content: ... }` because Pi's normal user serialization may omit the explicit `type`. Unmatched candidates remain covered by the opaque compaction but are not retained.

Then match Codex's 64K policy [C2]:

1. Walk eligible messages newest to oldest.
2. Count text with `ceil(UTF8 bytes / 4)`, minimum one token per message.
3. Keep whole messages while they fit.
4. If the next older message crosses the boundary, middle-truncate its text parts to the remaining token budget, preserving Unicode boundaries.
5. Preserve input images even when adjacent text is dropped.
6. Stop when the budget is exhausted.
7. Reverse back to chronological order.
8. Append the one canonical compaction item.

Use Codex's marker shape, for example `midd…1 tokens truncated…1234`, and unit-test the exact boundary examples from the pinned source [C2].

Pi cannot reliably identify persisted hook prompts as Codex `TurnItem::HookPrompt`. V1 therefore retains only provable real Pi user entries. Do not add fragile text-marker heuristics.

---

## 9. Trigger behavior

### Manual `/compact`

- `session_before_compact` runs one standalone side request.
- Ignore custom summary instructions with a warning.
- On success, return a Pi compaction with checkpoint details and usage.
- On cancellation or failure, return `{ cancel: true }`.

### Pi threshold

- If Pi's reserve-token threshold fires first, run the same lifecycle path with reason `threshold`.
- Do not fall back silently to Pi text summarization after a remote failure; preserve the previous branch and notify.

### Extension 90% threshold

- `context` frames the pending request.
- `before_provider_request` computes the effective input and runs compaction before that normal sampling request.
- Persist an inline custom checkpoint, then return `fresh prefix + replacement + fresh suffix`.

### Between tool calls

Pi invokes `context` and `before_provider_request` for each LLM request, not just once per user turn [P9]. Therefore the same 90% check runs before a tool-loop continuation, matching Codex's mid-turn placement [C3].

### Overflow recovery

- Pi removes the failed assistant from agent state, emits `session_before_compact` with `reason: "overflow"` and `willRetry`, installs successful compaction, and retries once [P6].
- Build source input from the active branch/context projection; Pi's shared transform skips errored/aborted assistant messages.
- Return lifecycle compaction on success so Pi owns the retry.
- Return `{ cancel: true }` on failure; do not send the same overflowing history again.

---

## 10. Failure, retry, and cancellation policy

### Retry matrix

Use at most three total attempts: initial plus two retries, matching Codex's V2 cap [C2].

| Failure | Retry? | State mutation |
| --- | --: | --- |
| Abort/cancellation | No | None |
| 401/403, auth refresh failure | No | None |
| 429/usage limit/quota/not included | No | None |
| Invalid request, unsupported parameter, context window | No | None |
| Missing/multiple/invalid compaction output | No | None |
| Network failure before terminal event | Yes | None |
| Premature SSE close or request timeout | Yes | None |
| 408/409/500/502/503/504 without terminal policy error | Yes | None |

Set provider `maxRetries: 0` so the extension owns the bounded V2 attempt count. Delay 500 ms then 1,000 ms, honor abort during sleep, and honor a reasonable server retry delay only when it remains within Pi's configured provider cap if that cap becomes publicly available.

### Fail-closed rules

- Never install before complete raw-output validation.
- Never replace a valid checkpoint with an invalid response.
- Never send Pi's placeholder summary for a lifecycle checkpoint.
- Never send an opaque checkpoint to a different provider/API/model/base URL.
- Never return the unreplaced payload after an active replay mismatch.
- Call `ctx.abort()` because Pi catches extension exceptions [P5].

### Persistence failures

- Inline: append only after remote success. If append or post-append branch verification fails, abort the pending normal request. The old full local history remains intact.
- Lifecycle: return success only after building a fully validated JSON value. Pi performs the append after the hook returns [P6].
- A crash after the remote call but before append loses only that compaction result; no previous checkpoint is removed.

### User visibility

Use one status key:

```text
codex-provider: Compacting with OpenAI Codex…
```

Clear it in `finally`. Notify once per source hash on final failure, checkpoint incompatibility, or replay mismatch. The custom-entry renderer shows:

```text
OpenAI compaction checkpoint · <model> · <input tokens> → <opaque/replacement estimate>
```

Do not print encrypted content, raw input, auth, headers, or server error bodies. No bespoke telemetry/event API is needed in v1. Lifecycle calls already produce Pi compaction events; inline metadata is available in its checkpoint entry.

---

## 11. Race and stale-state safety

The following are mandatory invariants:

1. **One operation:** one `inFlight` promise per session.
2. **Immutable source:** clone the input and envelope before awaiting network.
3. **Fresh install:** generation, model identity, leaf ID, and source hash must still match immediately before persistence.
4. **Abort propagation:** combine Pi's signal with the session-shutdown signal; any one aborts stream reading, clone parsing, and retry sleep.
5. **No stale usage:** server usage is trusted only after the active boundary; otherwise use the local effective-input estimate.

Queued steering/follow-up input that is not yet in the branch is not included in the checkpoint. Pi will deliver it after the blocked request resumes. If a queued action mutates the branch during the side request, leaf verification discards the result.

Do not lock files directly. The extension uses Pi's session append APIs, so it must not read or rewrite JSONL session files itself.

---

## 12. Portability and security

### Runtime and package boundaries

- Require Node `>=24`.
- Initial peer range: `@earendil-works/pi-ai >=0.83.0 <0.84.0` and `@earendil-works/pi-coding-agent >=0.83.0 <0.84.0`.
- Import only package-exported paths, including `@earendil-works/pi-ai/api/openai-responses-shared`.
- Do not import `dist/` files or Pi source paths.
- Add no runtime dependency; Node crypto, Web Streams, `Response.clone()`, `TextDecoder`, and Pi APIs are sufficient.

The narrow Pi peer range is intentional. Final payload shape, hook ordering, and stream callback availability are protocol dependencies even though the types are public.

### Provider/endpoint scope

- Send only through the currently selected registered `openai-codex` provider.
- Never hardcode a different destination or proxy.
- Normalize and compare the model's configured base URL; `null` means the provider default.
- Do not support arbitrary “Responses-compatible” providers in v1. Encrypted state portability is not proven.
- A fork may change Pi session ID, but not provider/API/model/base URL.

### Sensitive data

The opaque item and retained user images/messages are sensitive session content. They inherit Pi session-file storage and backup behavior. The extension creates no separate cache or log.

The custom fetch wrapper:

- must call the exact URL and init supplied by Pi's provider;
- must not inspect request auth/body;
- must not follow or add its own redirects;
- must parse only the cloned response body in memory;
- must release/cancel readers promptly.

Strict validation is required even though session files are local: sessions can be hand-edited, copied, generated by older code, or supplied by another machine.

---

## 13. Minimal package design

### Files

```text
codex-provider/
  package.json
  index.ts
  checkpoint.ts
  replay.ts
  remote.ts
  README.md
  LICENSE
  tests/
    checkpoint.test.ts
    replay.test.ts
    remote.test.ts
    index.integration.test.ts
    package.smoke.test.ts
```

Module responsibilities:

| Module | Responsibility |
| --- | --- |
| `index.ts` | Hook registration, state machine, trigger policy, status, lifecycle installation. |
| `checkpoint.ts` | Strict schema, active-boundary resolution, retention/truncation, identity and hashes. |
| `replay.ts` | Context framing, marker extraction, finalized input rewrite, tool normalization, token estimate/shrink. |
| `remote.ts` | Registered-provider attempt, SSE clone observer, output validation, retries and cancellation. |

Do not add config, logger, telemetry, HTTP, serializer, repository, service, or class hierarchy modules.

### Unit tests

`checkpoint.test.ts`:

- exact 64K newest-first retention and middle truncation;
- image-only minimum cost and image preservation;
- one new opaque item replaces an old opaque item;
- active boundary selection across forks, inline checkpoints, lifecycle checkpoints, and later Pi fallback;
- strict corruption/version/model mismatch outcomes.

`replay.test.ts`:

- prefix/suffix context survives while Pi baseline is replaced;
- markers are removed exactly once and never reach output;
- zero/multiple/reversed markers fail closed;
- missing/orphan tool output normalization is deterministic;
- trailing-only shrink stops at the first non-output.

`remote.test.ts`:

- provider-built envelope changes only in `input`;
- chunked CRLF/LF SSE, multiline `data:`, UTF-8 splits, `[DONE]`, and abort;
- exactly one compaction plus extra output succeeds;
- zero/two/empty compactions or no terminal event fail;
- retry matrix and three-attempt cap.

### Integration and smoke tests

Use a real `AgentSession` only for behavior that unit tests cannot prove:

- manual lifecycle compaction persists details and reloads context;
- threshold compaction happens before the pending provider fetch;
- a tool-loop continuation can compact inline;
- replay failure calls abort and sends no provider request;
- overflow success lets Pi perform its single retry.

The smoke test proves package discovery and public subpath imports only.

Do not build a full network integration suite. One mock Responses server and recorded request/stream fixtures are enough.

---

## 14. Phased implementation plan

### Phase 0 — blocking API spike

**Completed 2026-07-30: all five checks passed.** The executable evidence and remaining API gaps are in `spike-results.md`. The checks were:

1. Update the workspace Pi development/runtime versions to 0.83.0 or newer within the narrow supported range.
2. Prove `ctx.modelRegistry.getProvider("openai-codex").streamSimple()` accepts `fetch`, `onPayload`, `onResponse`, `env`, `sessionId`, and an abort signal.
3. Prove `Response.clone()` observes a raw compaction item while Pi's provider stream completes normally.
4. Prove `ctx.abort()` inside a caught `before_provider_request` failure results in zero network requests.
5. Prove `pi.appendEntry()` during `before_provider_request` is synchronous, branch-visible, and survives resume/fork.

The spike used the registered provider and a cloned mock SSE response; it did not add a direct HTTP client or mutate session files.

### Phase 1 — pure protocol core

Implement strict checkpoint parsing, branch resolution, history retention, token estimation, tool normalization, shrink, SSE parsing, and hashes. Finish all unit tests before registering hooks.

### Phase 2 — lifecycle path

Implement registered-provider attempts for manual, Pi threshold, and overflow. Persist checkpoint details through Pi compaction and verify resume/branch replay.

### Phase 3 — inline replay and timing

Add request framing, finalized payload rewrite, the 90% pre-request decision, inline custom-entry installation, and tool-loop integration tests. Enforce load-last documentation and fail-closed aborts.

### Phase 4 — parity hardening

Record request/replacement fixtures from the pinned Codex tests and compare:

- selected request fields;
- trigger count and position;
- normalized/shrunk input;
- retained replacement history;
- replay after resume, fork, repeated compaction, and tool loops.

Then run package-scoped unit/integration/smoke tests, Ultracite, repo type-checking, README policy checks, and the full suite if the dependency bump is cross-cutting.

---

## 15. Blockers and irreducible gaps

### Remaining implementation blocker

**No handler-order introspection.** Safe production use requires the extension to load last among context/payload/compaction mutators.

Phase 0 resolved the earlier version, clone-observer, abort-before-fetch, and append/resume/fork assumptions. It also confirmed that absence of a public raw output-item callback still forces the side request onto SSE; that is a fidelity gap, not a Phase 1 blocker.

### Prevents Codex-quality fidelity

- Pi extensions cannot atomically replace `Agent` history, session history, world-state baseline, compaction-window IDs, and usage totals as Codex does [C2, C7].
- A side request cannot reuse Codex's turn-scoped `ModelClientSession`, `x-codex-turn-state`, or exact cached-WebSocket `previous_response_id` continuation [C6].
- `fetch` observation forces SSE for the side request; Pi explicitly states custom fetch does not affect WebSockets [P3].
- Pi does not expose Codex installation/thread/turn/window metadata or `comp_hash` [C3, C6].
- Pi exposes no server-accurate token count for the finalized rewritten payload and no model `effective_context_window_percent`.
- Pi cannot add inline side-request usage to built-in session totals.
- Pi cannot classify arbitrary extension-injected user-role content as Codex real user, hook prompt, or reconstructible world state.
- Pi does not expose all resolved normal request options and header transforms to a side stream, especially after resume before any normal request.
- Session append plus pending-payload return is not one transaction.

Do not conceal these gaps with private imports, session-file rewrites, guessed metadata headers, or a duplicate provider implementation.

---

## 16. Acceptance criteria

### “Works” — required before release

| Criterion | Proof |
| --- | --- |
| Scope | Non-`openai-codex` models produce no payload/header/session changes. |
| Request | Mock server receives the registered-provider envelope with one trailing trigger and the `remote_compaction_v2` feature. |
| Output | One valid opaque item plus a terminal completion is required; malformed output installs nothing. |
| History | Replacement is retained real users within 64K plus one new opaque item; old checkpoints are absent. |
| Replay | Resume, fork-after-boundary, repeated compaction, and live tail all send checkpoint once with no Pi marker or old baseline. |
| Timing | Compaction can occur before first sampling, before tool-loop sampling, through Pi threshold, and during overflow recovery. |
| Safety | Cancellation, stale leaf/model, replay mismatch, persistence error, and final remote failure send no unsafe fallback request. |
| Tokens | 90% trigger, 95% fit estimate, stale-usage guard, and trailing-output-only shrink have invariant tests. |
| Security | No auth/request/raw-event logging; strict checkpoint validation; no endpoint change; no extra storage. |
| Quality gate | Package unit, integration, smoke, lint/format, typecheck, and README checks pass. |

Known and acceptable at this level:

- side compaction uses SSE, while normal requests retain Pi's configured transport;
- context framing can shift fallback item IDs on replay/threshold requests;
- inline compaction usage is checkpoint metadata, not Pi session totals;
- lifecycle requests after cold resume may lack non-public normal-request options;
- only provable Pi user entries are retained outside the opaque item.

### “Codex-quality” — not achievable by this standalone extension

All **Works** criteria plus:

| Criterion | Required Pi capability |
| --- | --- |
| Transport parity | Raw output-item callback for SSE and WebSocket plus access to the active cached continuation session. |
| Request parity | Final request envelope and resolved headers/options available to side requests without exposing secrets. |
| Metadata parity | Installation/thread/turn/window IDs, request kind, turn state, and model `comp_hash`. |
| History parity | Atomic public replacement of agent/session history with fresh world-state reinjection. |
| Token parity | Server-accurate effective-history usage, model effective window, and public usage reset/accounting. |
| Hook parity | Cancellable pre/post compact hooks with defined ordering for both lifecycle and inline attempts. |
| Transaction parity | One atomic operation covering checkpoint persistence, active context replacement, and pending request continuation. |

“Codex-quality” is accepted only when parity fixtures from the pinned Codex revision pass for request fields, transport continuation, output collection, replacement history, timing, retries, and token accounting. Until those Pi capabilities exist, describe the extension as **behaviorally compatible remote compaction V2**, not an exact Codex implementation.
