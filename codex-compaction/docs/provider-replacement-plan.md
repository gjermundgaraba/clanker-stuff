# Codex-quality provider replacement plan

## Status

Planning document. No provider replacement has been implemented.

This plan supersedes the earlier architectural constraint that normal requests must remain on Pi's built-in `openai-codex` stream handler. Existing checkpoint and replay behavior remains the implementation baseline until the replacement provider passes the acceptance gates in this document.

## Goal

Make Pi's `openai-codex` path behave as closely as practical to the current OpenAI Codex client in the parts that influence model input, context continuity, compaction, model transitions, and recovery.

Provider replacement is justified only where owning the complete request and transport lifecycle closes a verified Codex-parity gap. Existing extension code should remain in place when it already matches Codex safely.

## Intended outcome

The extension will register the complete effective `openai-codex` `Provider`, not only a stream override. It will delegate Pi's existing ChatGPT OAuth implementation and use Pi's static model catalog as the offline fallback, while owning the behavior that affects Codex parity. One coordinated subsystem will handle:

1. Normal Responses requests and their exact finalized options.
2. Cached WebSocket continuation and safe SSE fallback.
3. Remote compaction V2 on the active turn-scoped client session.
4. Durable opaque checkpoint installation and replay through Pi sessions.
5. Remote model metadata, compatible model transitions, context-window generations, and failure behavior.

## Quality target

The target is behavioral parity with Codex, not source-code similarity. A feature belongs in the replacement only when it preserves or improves one of these properties:

- The model sees the same effective instructions, tools, history shape, and fresh state at the same lifecycle point.
- Compaction runs for the same reasons and produces the same replacement-history shape.
- Continuation state advances consistently across normal responses, compaction, retries, and transport fallback.
- Model changes do not reuse incompatible history.
- A persisted Pi session can resume, fork, or recover without relying on unavailable server state.

## Boundaries

- Target Pi version: `@earendil-works/pi` 0.83.0 unless the repository deliberately changes that pin.
- Target provider/API: `openai-codex` and `openai-codex-responses`.
- Authentication: inherit Pi's built-in ChatGPT OAuth behavior; do not replace login or refresh without a demonstrated need.
- Direct Platform API-key support is a separate provider path and is not included automatically.
- The implementation remains fail closed for malformed opaque output, stale state, uncertain history provenance, and persistence failures.
- Pi capabilities that remain unavailable after provider replacement must be documented rather than approximated invisibly.

## High-level work plan

### 1. Refresh the evidence

- Inspect the latest OpenAI Codex source for normal request construction, WebSocket continuation, remote compaction V2, model metadata, world state, history replacement, telemetry, and fallback behavior.
- Recheck Pi 0.83.0's provider-composition, stream, session, and extension contracts.
- Update the research documents with current revisions, changed behavior, and the remaining parity boundary.

### 2. Define the owned runtime

- Identify the smallest provider surface that must be replaced.
- Reuse Pi's public serializers, types, OAuth, models, and event-stream contracts.
- Specify the per-session transport, continuation, compaction, and persistence state machine.
- Define explicit handoffs between provider-owned ephemeral state and extension-owned durable session state.

### 3. Implement in parity slices

- Establish normal-request parity before enabling integrated compaction.
- Add transport/session ownership and continuation parity.
- Move remote compaction into the active provider session.
- Add model-transition and fresh-context behavior.
- Retire superseded side-request logic only after equivalent recovery paths pass.

### 4. Validate before switching ownership

- Compare finalized request bodies, headers, output events, usage, and failure results against Pi's built-in provider.
- Exercise normal, tool-loop, manual, threshold, overflow, model-switch, resume, fork, cancellation, and malformed-response cases.
- Run live SSE and cached-WebSocket canaries, including forced fallback and process restart.
- Keep provider replacement opt-in until the complete acceptance matrix passes.

## Success criteria

1. Normal requests are wire-compatible with Pi's built-in provider for supported inputs and options.
2. Compaction uses the active provider session when Codex does and installs the same logical replacement window.
3. Every request uses `previous_response_id` only when Codex's exact eligibility test passes. A post-compaction request normally sends full compacted history on the same socket and turn state.
4. `comp_hash`, effective-window metadata, context-window generations, and fresh-context rules match current Codex behavior where their source data is available.
5. Every crash, cancellation, stale-state, and transport-fallback boundary has a deterministic recoverable result.
6. Turning provider ownership off while keeping checkpoint replay loaded restores Pi's built-in provider without migrating or losing session history.

## Evidence baseline

The technical design below is based on the [current provider-replacement research](provider-replacement-research.md): OpenAI Codex `2b5bdcf67547860f2e5c5a605009a70026796b2b` and Pi `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`v0.83.0`). If either dependency changes before implementation finishes, rerun the targeted source comparison before cutover.

## Technical architecture

### 1. Complete provider composition

Create one complete `Provider<"openai-codex-responses">` and register it for the existing `openai-codex` ID.

The provider will:

1. Reuse `openaiCodexProvider()` for `id`, `name`, `baseUrl`, OAuth, static fallback models, and any availability filter.
2. Own `getModels()` and `refreshModels()` so full Codex model metadata is available beside Pi's compatible model projection.
3. Own both `stream()` and `streamSimple()` so every supported request follows the same serializer and transport state machine.
4. Preserve Pi's provider options and callbacks, including payload/header transforms, response observation, cancellation, timeouts, retries, and injected `fetch`.

Do not introduce a second provider ID or copy Pi's login/refresh code. Configuration in `models.json` continues to compose above the registered provider through Pi's normal provider composer.

### 2. Reuse boundary

Reuse these existing components before adding code:

| Concern | Reuse |
| --- | --- |
| Authentication | Pi's built-in `openai-codex` OAuth object |
| Pi context serialization | `convertResponsesMessages()` and `convertResponsesTools()` |
| Pi event-stream conversion | `processResponsesStream()` |
| Opaque result validation | Current checkpoint/remote validation rules |
| Durable replay | Current checkpoint lookup, provenance checks, and finalized-request rewrite |

The new code should initially live in one provider module plus the existing lifecycle, checkpoint, and replay modules. Split transport or model-catalog code only when a second independent responsibility makes the provider module harder to test.

### 3. State ownership and lifetime

State must be separated by the lifetime Codex gives it:

| Lifetime | Owned state | Reset boundary |
| --- | --- | --- |
| Provider process | Current projected catalog and full Codex metadata map | Extension unload/process exit |
| Pi session | Cached WebSocket, last complete request/response, HTTP-fallback flag, window chain, current model metadata | Session shutdown, fork, reload, or incompatible resume |
| User turn | Fresh turn-state token, request kind/metadata, active client-session identity | Next `before_agent_start` after the prior run settles |
| Request | Payload, headers, retry attempt, response ID/items, cancellation | Request completion/failure |
| Durable checkpoint | Replacement history digest, model compatibility data, window generation, source provenance | Superseded by a committed checkpoint |

Use Pi's `before_agent_start` as the start of a Codex user turn and `agent_settled` as its safe end. Pi `turn_start`/`turn_end` represent individual model/tool-loop steps and must not reset the Codex turn-state token. A standalone manual compaction outside an agent run gets a one-off turn session.

Continuation state is an optimization only. Session resume, fork, reload, and process restart reconstruct complete input from durable Pi state and begin without a response ID or turn-state token.

### 4. Request pipeline

Each normal request follows one path:

1. Accept Pi's finalized `Model`, `Context`, and resolved stream options.
2. Serialize messages and tools with Pi's public Responses helpers.
3. Apply current Codex model metadata to reasoning, service tier, text settings, parallel tool policy, inclusion fields, and any Responses Lite variant.
4. Add only truthful canonical Codex metadata: Pi session/turn identity, extension-owned window identity, request kind, model transition, and compaction fields where applicable.
5. Run Pi's payload/header callbacks, dispatch through the chosen transport, and convert stream events through Pi's shared event processor.

The exact effective Pi system prompt and tools remain authoritative. Model-authored instructions from `/models` may be used only according to Codex's request rules and must not erase Pi's prompt. Codex-native permission, plugin, app, sandbox, or collaboration metadata is omitted unless Pi exposes an exact value.

Golden request fixtures must prove that the provider preserves all inputs supported by Pi's built-in provider: text/images, reasoning items, function and custom tools, structured output, deferred tools, service tier, and user transforms.

### 5. Transport and continuation

Implement Codex's transport semantics as one session runtime:

1. Prefer the configured transport; cache at most one healthy WebSocket per Pi session, honor Codex's connect/stream-idle timeouts, and replace a socket when the server reports its connection limit.
2. Attempt `generate=false` prewarm only when model, auth, system prompt, and tools are available. Prewarm is best effort; a mismatch simply makes the first request full.
3. Capture `x-codex-turn-state` from HTTP headers, the WebSocket upgrade, or WebSocket event metadata and replay it only within the active user turn.
4. Send a delta plus `previous_response_id` only when all Codex-compared non-input fields match and the new input is a strict extension of the prior request plus completed response output.
5. After WebSocket retry exhaustion, clear cached continuation state and use HTTP for the rest of that Pi session. Never guess a response ID after an ambiguous failure.

Continue using Pi's retry/cancellation limits where they are user-configured. Where Codex has stricter protocol retry behavior—especially V2 compaction—apply the Codex limit inside that operation.

### 6. Model catalog and transitions

Use the provider refresh hook to call Codex's authenticated model endpoint with the current client version. Honor cancellation, a 300-second freshness interval, `force`, ETag validation, and Pi's offline initialization mode.

Maintain two views:

- A valid Pi `Model[]` projection for the picker, context limits, and persistence through `ProviderModelsStore`.
- A provider-private map containing the complete model metadata needed for request construction and transitions.

After process restart, do not accept an ETag-only `304` until the private metadata map has been rebuilt; make one unconditional fetch if necessary. If refresh fails, retain the last complete in-memory view and Pi's static fallback catalog.

Before the first request on a changed model:

1. Compact with the previous model when both non-empty `comp_hash` values differ.
2. Compact on a downshift only when the model changed, the previous context window was larger, and active usage exceeds the new usable limit.
3. Retry eligible previous-model compaction failures with the current model, matching Codex's error allowlist.
4. Persist the compatibility hash and resolved limits used to install each checkpoint.

Missing hashes do not imply incompatibility; current Codex changes behavior only when both hashes are present and different.

### 7. Integrated remote compaction

Retain the current fail-closed trigger and checkpoint safety rules while moving the network request into the provider runtime.

For inline compaction:

1. Clone and normalize the finalized active history, trimming only trailing tool outputs when necessary to fit the attempt.
2. Use the active user-turn client session, current turn-state token, current transport, and compaction request metadata.
3. Require completion and exactly one opaque compaction output within Codex's retry budget.
4. Build retained history using the current 64,000-token user/agent-message rules, advance the context-window generation, then commit the durable checkpoint.
5. Continue the agent loop from the installed replacement. Usually send the complete replacement request because it is not prefix-compatible with the compaction request.

Manual lifecycle compaction uses the same algorithm with a one-off client session. Threshold, overflow, pre-turn model-transition, and mid-turn triggers differ only in trigger metadata and when the replacement is handed back to Pi.

### 8. Durable installation and recovery

Pi 0.83.0 cannot atomically replace arbitrary raw provider history and append a matching session entry. Keep the existing two-part installation:

1. Persist a strict checkpoint through Pi's compaction lifecycle.
2. Validate branch, generation, model, request provenance, digest, and lifecycle phase before rewriting the finalized provider payload to the checkpoint history.

Define checkpoint v5 only for new durable fields that are required by the provider runtime: current/previous window IDs, window number, model `comp_hash`, effective limit, and request-schema version. Preserve a strict read path for v4 so disabling the replacement or resuming an old session does not lose history.

Ephemeral transport state is never required for recovery. After any uncertain send, crash, cancellation, or restart, discard continuation state and resend complete validated history.

## Implementation sequence

### Phase 1: normal-provider parity

- Register the complete provider while delegating OAuth and static models.
- Reuse Pi's serializers/event processor and support SSE first.
- Add golden request/event comparisons against Pi's built-in provider.
- Keep existing side compaction and checkpoint replay unchanged.

Gate: all existing package tests pass and normal supported requests are wire-compatible except for explicitly documented Codex metadata additions.

### Phase 2: Codex transport and model state

- Add per-session WebSocket reuse, prewarm, exact continuation, turn-state handling, and permanent fallback.
- Add remote model refresh and the full metadata side map.
- Add window IDs and canonical truthful request metadata.
- Verify user-turn lifetime using `before_agent_start` through `agent_settled`.

Gate: transport tests prove both delta and forced-full paths, turn-state reset, fallback, restart, and stale-response rejection.

### Phase 3: integrated compaction and transitions

- Route inline and standalone V2 compaction through the provider client-session abstraction.
- Match current user/agent-message retention and fresh-context placement.
- Add `comp_hash` and downshift transition behavior.
- Add checkpoint v5 only after its final durable fields are proven by the integration tests.

Gate: manual, threshold, overflow, pre-turn, and mid-turn compaction survive resume/fork/reload and match current Codex request/history fixtures.

### Phase 4: cutover and deletion

- Run live SSE and WebSocket canaries with real tool loops, multiple compactions, forced fallback, and process restart.
- Make replacement ownership the default only after all acceptance gates pass.
- Delete side-SSE invocation and sentinel framing only when no recovery/test path depends on them.
- Keep checkpoint replay loaded when provider ownership is disabled so v4/v5 sessions continue through Pi's built-in provider.

Gate: the old network path is unused, all scoped validation passes, and disabling the provider loses no durable session state.

## Acceptance matrix

### Requests and tool loops

- Text, images, reasoning, structured output, custom/function tools, and deferred tools.
- Multi-step tool loops preserve one turn-state token until `agent_settled`.
- Changed instructions, tools, model settings, or history force a full request.
- Payload/header transforms and response callbacks run exactly once per attempt.
- Cancellation and retry errors produce one deterministic Pi stream result.

### Transport and recovery

- Prewarm success, mismatch, rejection, timeout, and no-auth/no-model skip.
- First-turn and later-turn socket reuse with fresh turn-state tokens.
- Delta eligibility, stale response ID, connection age/idle expiry, and connection limits.
- WebSocket failure becomes session-wide HTTP fallback.
- Resume, fork, reload, and restart send full history without server state.

### Compaction and model changes

- Manual, threshold, overflow, pre-turn, and mid-turn V2 compaction.
- Malformed/multiple/missing opaque output, incomplete response, retry exhaustion, and persistence failure.
- Retained real-user truncation, bounded non-final agent messages, and final-answer exclusion.
- Post-compaction full request on the same socket/turn token unless exact continuation eligibility passes.
- `comp_hash` change, missing hash, smaller-window downshift, and eligible previous-model fallback.

### Durable sessions

- v4 and v5 checkpoint parsing, tamper rejection, and branch/generation provenance.
- Crash before response, after response, and during checkpoint commit.
- Disable/re-enable without history migration or loss.
- Repeated compactions with monotonic window generations.
- Redacted diagnostics contain no prompt, tool argument, credential, header, or encrypted checkpoint content.

## Explicit limitations

Provider replacement does not close these gaps:

1. Pi still has no atomic raw-history replacement transaction; fail-closed payload rewrite remains necessary.
2. Pi's prompt, permission, plugin, skill, and agent-loop semantics remain Pi semantics, not Codex CLI world state.
3. Server-only attestation, internal routing, and unexposed backend state cannot be reproduced by an extension.
4. Direct OpenAI Platform API-key behavior remains a separate provider/auth path.

These limitations must remain visible in diagnostics and documentation. They are not grounds for silently approximate metadata or history.

The detailed architecture, state transitions, module boundaries, migration sequence, and test matrix will be added after the source and documentation refresh is complete.
