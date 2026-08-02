# Codex compaction: Codex vs. two Pi extensions

> Historical research snapshot. It records source behavior at the pinned revisions below, not the current extension contract. See [provider-replacement research](provider-replacement-research.md) for the latest Codex/Pi review and [design.md](design.md) for current behavior.

Research date: 2026-07-30

## Scope and reproducibility

This report compares the implementations at these exact revisions:

| Project | Revision inspected | Package/version |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | [`6219b7c40fc9c702c0aef9964e72b492558f60e4`](https://github.com/openai/codex/tree/6219b7c40fc9c702c0aef9964e72b492558f60e4) | Codex main |
| [ogulcancelik/pi-extensions](https://github.com/ogulcancelik/pi-extensions) | [`d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6`](https://github.com/ogulcancelik/pi-extensions/tree/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6) | `@ogulcancelik/pi-codex-compaction` 0.1.2 |
| [IgorWarzocha/howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff) | [`7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988) | `@howaboua/pi-codex-conversion` 3.0.3 |

The Howaboua package's own sync document names Codex [`e7d0e1417222347d7fef0f2589961b8d17eff739`](https://github.com/openai/codex/tree/e7d0e1417222347d7fef0f2589961b8d17eff739) as its reference baseline. That revision is 619 Codex commits behind the Codex revision inspected here. The comparison therefore distinguishes current behavior from the package's historical upstream baseline.

## Bottom line

Both Pi extensions implement **Codex remote compaction V2**, not the older `POST /responses/compact` protocol:

1. Send the active Responses history through the ordinary streaming Responses endpoint.
2. Append `{ "type": "compaction_trigger" }`.
3. Require one opaque encrypted `compaction` output item.
4. Persist recent real user messages plus that opaque item.
5. Replace Pi's textual compaction summary in later provider requests.

They differ mainly in **when they compact, how they reach OpenAI, how they persist/replay the checkpoint, and what they do on failure**:

- **Ogulcancelik** is a small, focused, fail-closed extension. It adds its own 90% provider-boundary trigger, directly calls Codex over HTTP/SSE, stores a model-locked checkpoint, and never falls back to Pi text summarization.
- **Howaboua** is a compaction subsystem inside a full Codex provider/transport adapter. It relies on Pi's compaction lifecycle, uses the registered Responses stream and cached WebSocket machinery, permits checkpoint reuse across models on the same provider/API/base URL, and normally falls back to Pi text compaction when a remote V2 attempt fails.
- **Codex itself** owns the whole turn lifecycle. It triggers at 90%, can compact before or during a turn, uses the active transport session, tracks model compaction compatibility, persists complete replacement history with context-window IDs, and has local, remote V1, and remote V2 lanes.

## Terminology

### Pi compaction

Pi's built-in compaction creates a human-readable summary and keeps a recent tail. It triggers when:

```text
contextTokens > contextWindow - reserveTokens
```

The default reserve is 16,384 tokens. Extensions can intercept manual, threshold, and overflow compaction through `session_before_compact`, either returning a replacement `CompactionEntry`, cancelling, or returning `undefined` to let Pi summarize normally.

### Codex local compaction

Codex asks the active model to write a textual handoff summary through a normal inference request. The replacement history contains recent user messages and the summary encoded as a user message. This is used when the provider does not support remote compaction.

### Codex remote V1

Codex sends the active transcript to the unary `POST /responses/compact` endpoint. The server returns the complete replacement `output` history. Neither Pi extension currently executes this protocol.

### Codex remote V2

Codex sends a normal streamed Responses request with a trailing `compaction_trigger`. The server returns an opaque encrypted `compaction` item. The client constructs the replacement history from recent user messages plus that item. `remote_compaction_v2` is stable and enabled by default in the inspected Codex revision.

## The OpenAI Codex implementation

### Three implementation lanes

Codex chooses compaction in this order:

1. The experimental token-budget/new-context implementation, when enabled.
2. Remote compaction for OpenAI and qualifying Azure Responses providers.
3. Local textual summarization for other providers.

For remote-capable providers, stable feature `RemoteCompactionV2` selects V2; disabling it selects V1. The same choice is used for manual and automatic compaction ([task dispatch](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/tasks/compact.rs#L36-L78), [automatic dispatch](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L1152-L1228), [feature default](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/features/src/lib.rs#L1442-L1447)).

### Trigger and turn lifecycle

Codex derives its automatic limit as at most 90% of the model's resolved context window ([`auto_compact_token_limit`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/protocol/src/openai_models.rs#L413-L424), [calculation](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/protocol/src/openai_models.rs#L454-L470)). It also treats the model's effective context window—normally 95% of the advertised window—as a hard cap.

Compaction can happen at four meaningful points:

- **Manual:** `/compact` runs a standalone compaction turn.
- **Pre-turn:** before sampling when the active history is already over the threshold.
- **Mid-turn:** after a model response when a tool/pending-input follow-up is needed and the threshold has been reached; compaction completes and the same turn continues.
- **Model transition:** before sampling after a compaction-compatibility hash change or a switch to a smaller context-window model. Codex first tries the previous model, then retries eligible failures with the current model.

The pre-turn and mid-turn paths are visible in [`run_pre_sampling_compact`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L985-L1015) and the [post-sampling rollover](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L375-L462). Model-transition handling is in [`maybe_run_previous_model_inline_compact`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L1050-L1145).

Codex runs pre- and post-compaction hooks, emits a context-compaction lifecycle item, records compaction-specific telemetry, and treats an automatic compaction failure as a turn failure rather than silently switching to textual summarization.

### Local textual compaction

The local lane:

1. Adds a synthetic prompt asking the model for a checkpoint handoff.
2. Streams a normal model response.
3. Reads the final assistant message as the summary.
4. Retains up to 20,000 approximate tokens of recent real user messages.
5. Appends the summary as the last user-role message.

The summary prompt and replacement-history construction are in [`compact.rs`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact.rs#L111-L393) and [`build_compacted_history`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact.rs#L611-L685). This is the only Codex lane that creates a human-readable summary.

### Remote V1

Remote V1:

- Uses unary `POST /responses/compact`.
- Sends model, complete Responses input, current instructions, active tools, parallel-tool setting, reasoning, service tier when appropriate, prompt-cache key, and text options.
- Receives a complete `output: ResponseItem[]` replacement history.
- Filters stale developer/context wrappers before installing the result.
- Captures and reuses Codex turn-state headers.

See [`compact_conversation_history`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/client.rs#L542-L648), the [compact endpoint client](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/codex-api/src/endpoint/compact.rs#L35-L88), and [V1 orchestration](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote.rs#L189-L300).

### Remote V2 request

Remote V2 deliberately goes through the ordinary Responses streaming stack:

1. Clone the current normalized model history.
2. If needed, shrink a contiguous suffix of oversized tool outputs.
3. Append `ResponseItem::CompactionTrigger`.
4. Build the same prompt shape as a normal turn: base instructions, active model-visible tools, parallel-tool policy, reasoning, service tier, prompt-cache key, and text settings.
5. Stream through the active `ModelClientSession`.
6. Require a normal `response.completed` and exactly one compaction output item.

The request is assembled in [`compact_remote_v2_attempt.rs`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2_attempt.rs#L30-L135). Collection and validation are in [`collect_compaction_output`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L330-L437). Additional non-compaction output items are tolerated; exactly one item must deserialize as `Compaction`.

The active client session matters. Mid-turn compaction can reuse sticky routing and cached WebSocket continuation instead of constructing a separate ad hoc HTTP request. Manual compaction creates a new model client session because it is a standalone request boundary.

### Remote V2 replacement history

The V2 response does not itself provide the full replacement transcript. Codex constructs:

```text
[recent retained real user messages, new encrypted compaction item]
```

Current behavior:

- Budget: 64,000 approximate text tokens.
- Selection: newest qualifying messages first.
- Boundary behavior: truncate the oldest selected message to fill the remaining budget.
- Preserve images/audio attached to retained messages; charge an image-only message at least one budget unit.
- Drop developer/system messages, stale injected context, assistant messages, tool calls/results, reasoning, and the old encrypted checkpoint.
- Preserve messages parsed as real user input and persisted hook prompts.
- Append the new encrypted item last.

See [`build_v2_compacted_history`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L439-L572) and the shared [post-processing filter](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote.rs#L302-L363).

Repeated V2 compaction sends the prior opaque item plus its live tail to OpenAI. The returned opaque item recursively subsumes that input, and only the new item is retained outside it.

### Context reinjection

Codex does not trust old developer/environment wrappers returned by remote compaction. It rebuilds canonical context from current session state.

- Pre-turn/manual compaction clears the old reference-context marker; the next regular turn injects fresh initial context.
- Mid-turn compaction inserts fresh initial context immediately before the last real user message, or before the final summary/compaction item as a fallback. The encrypted compaction item remains last because that is the model-trained shape.

This distinction is explicit in [`InitialContextInjection`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact.rs#L58-L105) and [`insert_initial_context_before_last_real_user_or_summary`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact.rs#L554-L609).

### Persistence, resume, forks, and rollback

Codex persists a `CompactedItem` containing:

- A textual message, empty for remote compaction.
- The complete replacement history, including the opaque item.
- Monotonic window number.
- First, previous, and current UUIDv7 context-window IDs.

It atomically replaces live history, persists the complete replacement history in the append-only rollout, and restores from the newest surviving checkpoint on resume. Fork/rollback replay can move past a compaction because the replacement history is a full materialized base.

See [`replace_compacted_history`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/mod.rs#L3206-L3252) and [rollout reconstruction](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/rollout_reconstruction.rs#L115-L187).

### Headers and protocol details

- `remote_compaction_v2` is included in `x-codex-beta-features` for the session's normal Responses calls as well as the compaction call.
- `compaction_trigger` is request control and is never persisted.
- The canonical output wire type is `compaction`; Codex also accepts legacy `compaction_summary` during deserialization.
- Opaque encrypted content is token-estimated like encrypted reasoning for local context accounting.

## `@ogulcancelik/pi-codex-compaction`

### Design

This is a dedicated 978-line implementation across `index.ts`, `native-compaction.ts`, and `config.ts`, excluding tests. It only activates when:

```text
provider === "openai-codex"
api === "openai-codex-responses"
```

It is enabled by default, has its own 90% threshold, and can be configured globally or per trusted project ([configuration](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/config.ts#L1-L47), [activation](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L43-L51)).

### Two trigger paths

#### Provider-boundary inline compaction

Before every Codex provider request, it:

1. Captures the final provider payload shape.
2. Reads Pi's latest context-usage percentage.
3. At or above the configured threshold, compacts if no valid checkpoint exists or an assistant message has been added since the latest checkpoint.
4. Appends a custom checkpoint entry immediately.
5. Replaces the pending request's `input` with the compacted history.
6. Lets the same provider request continue; it does not add a continuation prompt.

This is the extension's defining difference from Howaboua. It can compact between tool-loop model calls and continue the same Pi agent run, approximating Codex's pre-turn/mid-turn behavior ([inline decision and rewrite](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/index.ts#L143-L207)).

The post-checkpoint assistant check prevents immediate compaction loops while Pi's usage percentage is still stale or unknown after a checkpoint.

#### Pi lifecycle compaction

It also intercepts Pi's `session_before_compact` for manual, threshold, and overflow events. It calls remote V2 and returns a normal Pi `CompactionEntry` carrying opaque details. On overflow retry, it omits the latest failed assistant response from the compaction input ([event handler](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/index.ts#L224-L260)).

Therefore two thresholds coexist:

- The extension's provider-boundary threshold, 90% by default.
- Pi's own post-run threshold based on `contextWindow - reserveTokens`.

### Request construction and transport

The extension does **not** use Pi's registered provider stream for compaction. It directly calls:

```text
https://chatgpt.com/backend-api/codex/responses
```

or the equivalent URL derived from the current model's base URL. It:

- Reuses the latest provider payload minus `input`, `messages`, and `previous_response_id` when available.
- Forces `store: false`, `stream: true`, current instructions, active tools, `tool_choice: auto`, parallel tools, encrypted reasoning inclusion, a stable session prompt-cache key, and text verbosity.
- Appends `compaction_trigger`.
- Extracts the ChatGPT account ID from the OAuth JWT and builds Codex-specific headers itself.
- Uses HTTP/SSE only; it cannot reuse Pi's cached WebSocket or `previous_response_id`.

See [`buildCompactionRequestBody`](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L416-L456), [headers](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L477-L508), and [direct client](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L638-L670).

It adds `remote_compaction_v2` to all ordinary Codex requests through `before_provider_headers`, matching Codex's session-wide advertisement ([header hook](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/index.ts#L134-L141)).

### Pi-to-Responses serialization

For a first inline checkpoint, the extension can use Pi's already-finalized provider `input` directly. For Pi lifecycle events and replay after a checkpoint, it reconstructs Responses items from Pi branch entries.

Its mirror handles:

- User text and images.
- Assistant encrypted reasoning signatures.
- Assistant output item IDs and phases.
- Function calls/results.
- Aborted/error assistant messages.
- Orphan calls, for which it synthesizes `"No result provided"`.
- Dynamically loaded tools through client-side tool-search call/output items.

This is substantial provider-parity code ([message conversion](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L183-L349)). Its limitation is structural: it duplicates Pi's Codex serializer and can drift as Pi's provider format evolves.

### Replacement history

It retains:

```text
[up to 64k approximate tokens of newest user-role messages, new opaque item]
```

Behavior:

- Uses roughly one token per four JavaScript characters.
- Truncates the oldest selected message in the middle to fill the remaining budget.
- Preserves non-text content on a retained user message.
- Drops assistant/tool/reasoning/old-compaction items.
- Does not classify real user input versus Pi-injected user-role context; any non-empty user-role message is eligible.

See [`retainRecentUserMessages`](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L383-L414).

This is close to Codex's budget and boundary truncation, but less selective than Codex about injected context.

### Persistence and replay

It has two checkpoint forms:

- Inline compaction: a context-free custom Pi entry.
- Pi lifecycle compaction: a normal `CompactionEntry.details`.

Both store:

```text
kind
version
provider:api:model key
complete replacementHistory
```

The checkpoint parser requires exactly one encrypted `compaction` item and requires it to be the last item. Replay starts from the newest checkpoint on the active branch and appends converted branch entries after it ([checkpoint parsing](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L62-L125), [effective replay](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L351-L381)).

A newer ordinary Pi compaction is authoritative and disables the older native checkpoint. Repeated native compaction replaces rather than nests the old opaque item.

### Model and provider switching

The checkpoint is locked to exact:

```text
provider + API + model ID
```

If the latest native checkpoint belongs to another model, the next Codex request is aborted. An unrelated provider is left untouched, but it cannot consume the encrypted checkpoint and sees only the surviving Pi tail. Switching providers is therefore not a portability mechanism.

### Failure and retry policy

The extension is deliberately fail-closed:

- Inline failure aborts the pending provider request and replaces its input with `[]`.
- Pi-event failure returns `{ cancel: true }`, preserving old history and preventing Pi text summarization.
- A malformed or wrong-model checkpoint blocks the next Codex request.

The direct client performs up to three total attempts. It retries network/generic stream failures, HTTP 408/409/429/5xx, and incomplete streams. Explicit SSE error messages, malformed data, invalid output, and most 4xx responses are non-retryable ([SSE validation and retry policy](https://github.com/ogulcancelik/pi-extensions/blob/d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6/packages/pi-codex-compaction/native-compaction.ts#L510-L670)).

### UI and local marker

Pi requires a summary string for `CompactionEntry`, so the extension stores a random local marker. It removes Pi `compactionSummary` messages from provider context whenever a native checkpoint is active. TUI mode appends context-free `running`, `complete`, or `failed` custom entries.

## `@howaboua/pi-codex-conversion`

### Design

Compaction is one subsystem in a much larger Codex adapter. Native compaction is off by default and enabled through `/codex` or:

```json
{
  "compaction": {
    "responsesCompaction": true
  }
}
```

Current executable compaction is V2 only. The old `openai-native-compact-v1` strategy string is accepted solely so existing sessions remain replayable ([strategy types](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/types.ts#L3-L18), [default](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/activation/config.ts#L61-L94)).

Native compaction is limited to:

- The OpenAI Codex provider.
- Explicitly configured OpenAI/Codex-compatible Responses passthrough providers.

It supports both `openai-codex-responses` and `openai-responses`, provided the selected registered provider exposes a compatible raw-item-aware `streamSimple` ([runtime resolution](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction-runtime.ts#L1-L62), [activation policy](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/activation/runtime-plan.ts#L108-L149)).

### Trigger path

Howaboua only handles Pi's `session_before_compact` event. It does not inspect usage at each provider boundary and does not add a separate 90% trigger. Manual, threshold, and overflow timing remains Pi-owned.

Consequences:

- Changing Pi's `reserveTokens` changes the automatic trigger point.
- It cannot independently reproduce Codex's pre-turn/mid-turn rollover decision.
- It cannot create Ogulcancelik's inline custom checkpoint before the same pending provider request.
- It does inherit Pi's manual, threshold, overflow-retry, branch, and session lifecycle.

For GPT-5.6 Codex models, the bundled provider currently clamps model metadata to a 272,000-token production window so Pi does not wait for an unverified 372,000-token window ([window clamp](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/providers/openai-codex/oauth.ts#L22-L57)). That alignment is separate from the V2 request-shrinking budget.

### First and repeated compaction input

The first native compaction serializes the **full active Pi session**, not merely Pi's `messagesToSummarize` subset. This deliberately matches Codex remote compaction's whole active transcript.

Repeated compaction uses:

```text
[latest persisted opaque window, exact live branch tail]
```

It reconstructs the active branch using Pi's `buildSessionContext`, reuses the package's own Responses serializer, respects image blocking, restores Code Mode grammar contracts, and filters adapter display messages ([input construction](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L152-L182), [serializer](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/serializer.ts#L144-L173)).

This avoids maintaining a second independent provider serializer, although it couples compaction to the package's custom provider implementation.

### Request construction and transport

Howaboua invokes the selected provider's registered `streamSimple` and then rewrites the generated normal Responses payload:

- Uses current model, active provider instructions, active tools, thinking effort, text verbosity, fast/service tier, and stable Pi session prompt-cache key.
- Appends `compaction_trigger`.
- Adds `remote_compaction_v2` to the compaction request.
- Captures raw completed output items.
- Uses cached WebSocket transport by default for OpenAI Codex.
- Falls back from WebSocket to SSE.

See [`buildCompactionRequestOptions`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L74-L119) and [`executeRemoteCompactionV2`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/remote-v2-client.ts#L71-L157).

The extension captures the provider's final active instructions after downstream prompt extensions. That lets a cached WebSocket compaction use only a compatible continuation delta when possible instead of replaying the full history. After successful native compaction it resets transport state and prewarms from the new checkpoint.

Unlike current Codex and Ogulcancelik, the explicit feature merger is only applied inside the V2 compaction client; ordinary follow-up requests are not globally decorated by this subsystem.

### Oversized request handling

Before adding the trigger, the package normalizes tool call/output pairs:

- Drops orphan and duplicate outputs.
- Synthesizes `"aborted"` outputs for unmatched function, custom, and client tool-search calls.

If the request is too large, it walks backward through a contiguous suffix of tool outputs and replaces their payloads with Codex's standard truncation marker until the request fits or a non-output item ends the eligible suffix.

Budget:

- 372,000 tokens for GPT-5.6 Codex compaction, independent of the provider's temporarily clamped 272,000 model metadata.
- 95% of model context for other compatible routes.

Token estimation uses `js-tiktoken` with `o200k_base` ([normalization](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/providers/openai-responses/tool-history.ts#L87-L150), [request shrinking](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/request-shrink.ts#L30-L120)).

This is materially closer to current Codex than Ogulcancelik's unshrunk direct request.

### Output validation

The package:

- Accepts both `compaction` and legacy `compaction_summary`.
- Requires non-empty `encrypted_content`.
- Validates optional item ID and turn metadata.
- Requires normal provider completion with a response ID.
- Requires exactly one canonical compaction item while tolerating additional output items.
- Captures input/cache-read/cache-write/output usage.

### Replacement history

Default output:

```text
[newest whole real user messages within 64k approximate tokens, opaque item]
```

Differences from Codex:

- Retention is configurable to 16k, 32k, or 64k.
- Uses UTF-8 bytes divided by four.
- Never slices a message.
- Always keeps the newest qualifying message whole even if it alone exceeds the budget.
- Stops at the first older message that does not fit, preserving a contiguous newest window.
- Explicitly removes Pi/Codex injected context markers and hook-prompt parts.
- Preserves non-text parts such as images.

See [`buildRemoteCompactionV2Window`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/remote-v2-history.ts#L49-L138).

Current Codex truncates the boundary message and preserves persisted hook prompts. Howaboua instead keeps whole messages and drops hook prompts. This is an intentional approximation, not byte-for-byte Codex parity.

### Pi checkpoint format

Howaboua always returns a standard Pi `CompactionEntry` with the local shim summary:

```text
[OpenAI native compaction checkpoint]
```

`details` stores:

- Strategy/version.
- Provider, API, model, and base URL.
- Complete compacted window.
- Compact response ID and creation time.
- Tokens-before and previous-summary metadata.
- Compaction usage.

Pi's `firstKeptEntryId` and summary satisfy Pi's session format. They are placeholders for provider purposes; before each provider request, the extension replaces Pi's textual replay with the opaque window.

### Provider replay

Provider replay is the largest difference in implementation complexity. The package:

1. Finds the native compaction boundary and Pi's first-kept boundary.
2. Extracts fresh leading/trailing system/developer preamble from the finalized provider payload.
3. Clones the opaque compacted window.
4. Serializes the live post-compaction tail.
5. Compares Pi's expected replay shape against the actual provider payload.
6. Replaces the Pi summary and pre-compaction kept window with the opaque window.
7. Preserves in-flight payload items not yet persisted to the session.
8. Uses a lenient replay path when a newer ordinary Pi compaction exists.
9. Throws before transport if it cannot produce a safe replay.

See [`native-replay-segments.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/replay/native-replay-segments.ts#L94-L319) and [`rewriteCodexCompactedProviderRequest`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L298-L325).

### Identity and model switching

For recursive compaction and replay, the current implementation matches:

```text
provider + API + normalized base URL
```

It records the model but does not require the same model ID. This permits reuse across model changes on the same compatible Responses endpoint. A checkpoint from a different provider/API/base URL is rejected.

This is more permissive than Ogulcancelik's exact model lock, but less expressive than Codex's `comp_hash` transition logic. It assumes the endpoint owns opaque checkpoint compatibility.

### Failure and fallback policy

The behavior is conditional:

- User abort: cancel compaction.
- Missing auth/base URL or malformed state: cancel rather than risk context loss.
- Unsupported provider/API: return `undefined`; Pi handles compaction normally.
- Remote stream failure or invalid result: notify, return `undefined`, and let Pi text compaction run.
- Unexpected exception: cancel.
- Provider replay failure after a checkpoint: throw and block the request.

Before falling back to Pi text compaction, it stashes the latest valid native window. Its `before_provider_request` handler recognizes Pi's summarization request and injects the opaque window, so the fallback summary can include information already hidden inside the encrypted checkpoint. It can then continue replaying the previous native blob even when a newer Pi compaction entry exists ([fallback stash/injection](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L25-L48), [injection handler](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L327-L362)).

This availability-first fallback is the opposite of Ogulcancelik's no-text-fallback policy.

### Retry policy

For OpenAI Codex, each transport gets up to three attempts. A cached-WebSocket lane can then fall back to a separate SSE lane, yielding up to six attempts in the worst retryable case. It does not retry 429, auth/permission/quota/usage-limit errors, invalid requests, context-window failures, or unsupported parameters. Invalid output is not retried.

### UI

After Pi stores a successful native checkpoint, the extension adds:

- A visible explanation that the checkpoint is encrypted and provider-sensitive.
- A compact usage line with input, cache read/write, and output tokens.

These are custom messages rather than custom entries, so the package explicitly filters them from provider context.

## Side-by-side comparison

| Dimension | OpenAI Codex | Ogulcancelik | Howaboua |
| --- | --- | --- | --- |
| Implementations | Local, remote V1, remote V2 | Remote V2 only | Remote V2 only; legacy V1 metadata replay |
| Default | V2 stable and on | Extension auto-compaction on | Native compaction off |
| Automatic trigger | 90% model limit | Own 90% provider-boundary check plus Pi threshold | Pi threshold only |
| Mid-turn continuation | Native, same client session | Yes, through `before_provider_request` | No independent mid-turn trigger |
| Manual `/compact` | Native standalone task | Pi event override | Pi event override |
| Overflow recovery | Codex-owned turn lifecycle | Pi event; failed assistant excluded | Pi event and Pi fallback machinery |
| V1 endpoint | Supports `/responses/compact` | No | No |
| V2 endpoint | Normal streamed Responses | Direct HTTP/SSE to Codex Responses | Registered normal Responses stream |
| WebSocket cache | Active client session | No | Yes, then SSE fallback |
| Finalized provider payload | Native canonical builder | Exact payload on first inline call; mirrored later | Own provider serializer plus finalized preamble |
| Trigger item | Trailing, transient | Trailing, transient | Trailing, transient |
| Feature header | All session Responses calls | All Codex calls | Explicit compaction call only |
| Tools/instructions | Active turn state | Active Pi tools and current/cached payload | Active adapter tools and final active provider prompt |
| Oversized request | Rewrite contiguous trailing tool outputs | No pre-shrink | Normalize pairs and rewrite contiguous trailing outputs |
| Output acceptance | One compaction; extra items allowed | One `compaction`; extra items allowed | One `compaction`/alias; extra items allowed |
| Retention default | 64k | 64k | 64k |
| Retention options | Fixed | Fixed | 16k/32k/64k |
| Boundary message | Truncated to fit | Truncated to fit | Kept whole; may exceed budget |
| User-message classification | Real users plus persisted hooks | Every user-role message | Real users; drops injected context and hooks |
| Checkpoint form | Native rollout `CompactedItem` | Inline custom entry or Pi `CompactionEntry` | Pi `CompactionEntry` |
| Stored state | Full replacement history + window chain | Replacement history + exact model key | Window + endpoint identity + response/usage metadata |
| Resume/fork basis | Native rollout reconstruction | Newest checkpoint on active Pi branch | Pi boundary/replay reconstruction |
| Same-endpoint model switch | `comp_hash`-aware; proactive compaction | Blocked | Allowed |
| Provider switch | Native provider policy | Non-Codex untouched; opaque context unavailable | Opaque context unreliable; mismatch protected |
| Remote failure | Ends automatic turn; no local fallback | Fail closed; cancel/abort | Usually fall back to Pi text compaction |
| Retry maximum | Three V2 stream attempts | Three HTTP/SSE attempts | Three per transport; up to six with WS→SSE |
| Status | Native lifecycle events/telemetry | Running/completed/failed custom entries | Completion explanation and usage custom messages |

## Fidelity assessment

### Where Ogulcancelik is closest to Codex

- Explicit 90% threshold.
- Provider-boundary operation can compact during a tool loop and continue the same run.
- Fail-closed behavior avoids changing an opaque checkpoint into a lossy text summary.
- Session-wide `remote_compaction_v2` header.
- 64k newest-user retention with boundary truncation.
- Old encrypted item is replaced, not nested.

### Where Ogulcancelik diverges

- Direct HTTP/SSE bypasses the active provider session, WebSocket continuation, sticky routing abstractions, provider retries, and registered proxy behavior.
- It duplicates Pi's serializer.
- It does not shrink oversized trailing tool outputs.
- It retains injected user-role context that Codex would classify and drop.
- It locks checkpoints to model ID rather than Codex's compatibility hash.
- It lacks Codex's window IDs, world-state baseline, pre/post hooks, telemetry, previous-model transition compaction, and native rollout replay.

### Where Howaboua is closest to Codex

- Uses the ordinary registered Responses stream and cached transport lifecycle.
- First compaction sends the full active transcript.
- Repeated compaction sends the prior opaque window plus exact live tail.
- Reuses the provider serializer and active request options.
- Reconciles tool-call/output history and shrinks trailing outputs.
- Requires a completed stream and exactly one canonical encrypted item.
- Persists detailed identity/usage state and aggressively prevents placeholder leakage.
- Captures fresh provider preamble and preserves in-flight payload tail.

### Where Howaboua diverges

- Trigger timing is Pi-owned, not Codex's native 90% pre-/mid-turn decision.
- Failure normally degrades to Pi text summarization.
- Whole-message retention and hook filtering differ from Codex.
- Model compatibility is inferred from provider/API/base URL rather than `comp_hash`.
- The V2 feature header is not added to every ordinary follow-up by the compaction subsystem.
- Pi replay parity requires a large adapter-specific reconstruction layer that Codex does not need.

## Operational implications

### Do not install both

Both extensions intercept `session_before_compact` and rewrite provider requests. Pi runs provider payload handlers in extension load order. Installing both creates order-dependent behavior around:

- Which extension performs the remote call.
- Which checkpoint schema is newest.
- Whether a Pi summary is filtered or rewritten.
- Which feature/header/payload mutations reach the provider.
- Whether failure cancels or falls back.

There is no useful cooperative composition between the two.

### Opaque checkpoints are not portable summaries

All V2 variants store OpenAI-encrypted content. A non-compatible provider cannot interpret it. Any UI text such as `[OpenAI native compaction checkpoint]` is only a local marker, not a semantic summary. Provider switching after native compaction can therefore leave another model with only the surviving tail.

### Serializer parity is the main Pi-specific risk

Codex owns one canonical `ResponseItem` history. Pi stores provider-neutral messages and only builds Responses items at request time. A Pi extension must either:

- Reuse the exact provider serializer and transport, as Howaboua does inside its own adapter; or
- Mirror provider conversion itself, as Ogulcancelik does.

The former is more coupled but has better parity. The latter is smaller and provider-independent at the API boundary but accumulates drift risk.

### Trigger fidelity and transport fidelity are split

Neither extension is strictly "more faithful" in every dimension:

- Ogulcancelik is closer to Codex's **timing and fail-closed lifecycle**.
- Howaboua is closer to Codex's **request, transport, cache, and replay machinery**.

### Current Codex is a moving target

The inspected Codex implementation includes recent work on:

- Stable V2 default.
- Context-window chain IDs.
- Full replacement-history persistence.
- Model compatibility hashes and previous-model fallback.
- World-state/context reinjection.
- Raw usage, cache-write accounting, and rollout tracing.

Neither Pi extension reproduces all of this because Pi does not expose equivalent lifecycle concepts, and the Howaboua package's documented upstream baseline predates the inspected Codex revision.

## Practical selection

Choose **Ogulcancelik** when the requirement is:

- A standalone compaction-only extension.
- Exact OpenAI Codex OAuth/provider scope.
- Automatic 90% provider-boundary compaction.
- No silent text-summary fallback.
- Minimal integration with unrelated Codex tools/features.

Choose **Howaboua** when the requirement is:

- The full Codex adapter is already desired.
- Cached WebSocket and provider request parity matter.
- Compatible Responses proxies are needed.
- Recovery through Pi text compaction is preferable to stopping.
- Complex replay across Pi compaction/fallback states is worth the larger subsystem.

For a new implementation intended to track Codex most closely, the strongest design would combine only these proven properties:

1. Ogulcancelik's provider-boundary 90% trigger and fail-closed invariant.
2. Howaboua's registered stream, provider serializer, tool-history normalization, and transport reuse.
3. Codex's real-user classification, 64k boundary truncation, session-wide feature header, and compatibility metadata.
4. One Pi `CompactionEntry` checkpoint format with strict validation and full replacement history.

That hybrid does not exist in either inspected package.
