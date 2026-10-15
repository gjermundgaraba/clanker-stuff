# claude-bridge redesign

A clean-break redesign of the provider core. The extension no longer tracks pi-claude-bridge; behavior stays the same where it is correct and changes where the review found it wrong. This is a working plan: delete it once the redesign lands.

## Goals

- One state model: a conversation per pi session, kept process-wide and driven by an XState v6 machine.
- One sync decision per request, made from message content rather than counts.
- The forwarded prompt built from pi's system-prompt sections, with no capture registry.
- Fix review findings 1–9 and 11. Finding 10 (provider `env`) stays out of scope.

## Facts the design relies on

- pi passes `options.sessionId` on every agent turn (`sdk.ts:435`) and none for compaction (`agent-session.ts:2765`).
- Re-registering a provider merges the config and replaces `streamSimple` (`model-runtime.ts:928-948`), so registering on every evaluation is safe once streams hold no state.
- Subagents copy the parent's registered provider config, stream function included, into each child runtime (`subagents/runtime.ts:163-182`).
- System messages carry named `sections` (`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, extension sections), read through `getCurrentSystemMessage()`.
- An XState v6 callback child stops with its state, and events it sends after stopping are dropped (`actors/callback.ts`, the `stopped` check in `sendBack`).

## Architecture

### Conversations

`conversations.ts` holds a process-wide `Map<piSessionId, Conversation>` on `globalThis`. A conversation is a running conversation-machine actor plus its sync record:

- `ccSessionId`: the Claude Code session it resumes, or none before the first turn.
- `sent`: fingerprints of the messages Claude Code holds, in order.

Every stream function resolves its conversation through this map, so it does not matter which evaluation's stream pi calls. `session_shutdown` stops the actor and removes the entry. A pi restart starts empty; the first turn rebuilds, as a resumed session does today.

### Sync decision

`sync.ts` exports a pure function from the sync record and pi's request history to one of:

| Decision  | When                                                                                                                                                                           | Action                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliver` | A query is parked, the history extends `sent` with only results for its waiting calls (plus an optional steer), and the tools and system fingerprints match the parked query's | Hand the results (and steer) to the parked query                                                                                             |
| `resume`  | `sent` is a prefix of the history and the tail is one user turn                                                                                                                | Resume `ccSessionId` with that turn as the prompt                                                                                            |
| `import`  | `sent` is a prefix and the tail holds anything else (another provider's turns, tool results with no parked query)                                                              | Append the tail to the session file, then resume with the trailing user turn, or with the continue prompt when the tail ends in tool results |
| `rebuild` | `sent` is not a prefix, or there is no record                                                                                                                                  | Rewrite the session file from pi's history in place under the existing id (a fresh id only when none exists), then resume as for `import`    |

Any decision other than `deliver` discards a parked query first, with one exception: a request whose history ends in a user message while the conversation is `active` is a side call (an extension one-shot under the live session id), not pi's agent loop, since an abort has already moved the machine to `idle`. A side call runs as an ephemeral conversation (its own machine, a fresh Claude Code session rebuilt from its history and deleted afterwards) and leaves the live conversation untouched. pi's own requests while `active` (a retry after mid-turn compaction) end in tool results and take the discard path. Each decision writes one debug line: `sync: deliver`, `sync: resume`, `sync: import n=<count>`, `sync: rebuild reason=<prefix|none|stale-tools|stale-system>`.

A fingerprint hashes a pi message's role and content. Timestamps, usage, stop reason, and api, provider and model fields are excluded. `sent` advances when Claude Code accepts something: the prompt, delivered results, an acknowledged steer, and each assistant message the bridge emits. `sent` holds only messages pi sent, never the continue prompt or anything Claude Code adds to its own file; fingerprinting a synthetic message would make every later request mismatch and rebuild. A missed steer is never fingerprinted, so the next request rebuilds. An abort, an error result, and a query that ends without a result clear `sent`, so the next request rebuilds (this covers pi's retry after an overload result).

To verify live: rebuilding in place after an abort. Claude Code may still be flushing its own file when killed; if the abort test misbehaves, abort takes a fresh id.

### Conversation machine

`machine/conversation.ts`, grown from the spike:

- `idle`: no query.
- `active`: invokes the query child, the callback actor reading Claude Code's messages. Leaving `active` stops it, closes the query, and answers every waiting MCP handler.
  - `streaming`: has the pi stream. `stream_event` and `assistant` messages go through the translation (below) and are pushed to it. A tool call ends the stream and moves to `parked`.
  - `parked`: no pi stream; MCP handlers and early results wait here. An `after` delay warns about a stuck handler.
  - `delivering`: a steer was written to the prompt stream and its acknowledgement is pending. On acknowledgement it releases the results and moves to `streaming`; a rejected steer clears `sent` and still releases them.
- Abort, a query error, a query that ends without a result, and a `result` message all leave `active` for `idle`.
- Abort comes from pi's per-call `AbortSignal`s. The signal of the call that started the query is listened to for the whole of `active`, so Esc during tool execution (while `parked`, with no provider call open) still aborts; each `pi.deliver` call's signal is listened to as well. Leaving `active` removes the listeners.
- A rate-limit rejection is remembered in context, names the next failure as a quota error, and notifies once.

Events: `pi.prompt`, `pi.deliver` (results, optional steer, new pi stream), `pi.abort`, `cc.message`, `cc.end`, `cc.error`, `cc.toolCall`, `steer.acked`, `steer.rejected`.

### Translation

`translate.ts` replaces `query/events.ts` and the content half of `query/consume.ts`. It works on a per-turn value (output message, open blocks, stream message id and open flag, block start, tool-call ids, flags) instead of `QueryContext`, and returns the pi events to push. Stall recovery stays. A `result`'s text is pushed only when the turn produced no text (finding 8).

### Prompt

`prompt.ts` replaces `prompt/capture.ts`, `prompt/recorder.ts` and `prompt/transcript.ts`:

- Forward every section except `tools`, `rules`, `docs`, `cwd` and a `preamble` that starts with pi's preamble, verbatim and in pi's order.
- Forward a system message without sections as written.
- The gate stays: pi's preamble at a line start, or both trigger doc paths in one part, refuses the turn and names the source context files.
- `rules` is never forwarded: it mixes pi's own fixed bullets (an unknown third-party-gate and Extra Usage risk) with tool guidelines. Tool guidelines travel with their tools instead (below).

### Tool guidelines

Each served MCP tool's description ends with that tool's `promptGuidelines`, read from `pi.getAllTools()` when the query's tool server is built, the way codemode lists hidden tools' guidelines with their declarations. Guidelines reach Claude with the tool they describe and no pi text is forwarded. Top-level `promptGuidelines` not tied to a tool are not forwarded.

### Unchanged in role

`summary.ts` (isolated summaries), `session/convert.ts`, `session/attachments.ts`, `session/verify.ts`, `session/cwd.ts` (`rememberSummarySession` included), `mcp-server.ts` (plus guidelines in descriptions), `tools.ts`, `models.ts`, `child.ts`, `log.ts`, `json.ts`, `turn.ts`, `query/prompt-stream.ts`, `query/usage.ts`.

### Deleted

`bridge.ts`, `shared.ts`, `stream.ts`, `provider.ts` (replaced by a thin `provider.ts` holding the config and the stream entry), `query/context.ts`, `query/consume.ts`, `query/events.ts`, `query/tool-results.ts`, `session/mirror.ts`, `prompt/`. In `index.ts`, the `before_agent_start`, `agent_start`, `turn_start`, `session_compact` and `session_tree` handlers and the `session_start` mirror clearing go. `session_start` keeps `rememberSessionCwd`.

## Steps

Each step ends with `vp check` and `vp test --project unit` on the package, and a commit proposal.

1. **Small fixes in surviving modules.**
   - Finding 1: map the summary result's `stop_reason`, so `max_tokens` reports `"length"`.
   - Finding 6: route to the summary path only for `cacheRetention: "none"` with a single user message and no tools; any other `"none"` request fails with a clear error. Delete the `streamFn` inventory test.
   - Finding 9: drop the injected 120-second bash timeout.
   - Finding 11: reject every queued prompt-stream item when the consumer returns.
2. **Prompt projection.** Add `prompt.ts`, switch the stream to it, delete `prompt/` and the recorder handlers. Append each served tool's guidelines to its MCP description. Live smoke run.
3. **Sync decision and fingerprints.** Add `sync.ts` with offline tests for the three live scenarios: append-only turns, a provider handoff whose other-provider turn includes a tool call (so `import` exercises `convert.ts` on non-bridge tool calls), and a history after a compaction entry (expecting `rebuild reason=prefix`). Also cover a same-length rewrite, a shorter history, a missed steer, the continue prompt staying out of `sent`, and a side call while `active`.
4. **Translation.** Extract `translate.ts` from `events.ts` and `consume.ts`, port their tests, fix finding 8.
5. **Machine.** Grow the spike: `delivering`, translation wiring, the rate-limit rejection, signal-driven abort (including while `parked`) and error paths. Machine tests with fake queries and `SimulatedClock`.
6. **Wiring.** Add `conversations.ts` and the new `provider.ts`; route the stream through the machine and the sync decision; delete the old core. Add `machine/` and new top-level files to `package.json` `files`.
7. **Live acceptance.** Update `tests/live.ts` to parse the `sync:` lines and map the old assertions so their meaning holds: `clean-start` and a `first` rebuild become `rebuild reason=none`; a `preserved` rebuild becomes `import` for the provider handoff and `rebuild reason=prefix` after compaction; `Case 3` reuse becomes `resume`. Run the full live suite.

## Tests

- **Unchanged:** session (convert, attachments, verify, cwd), mcp-server, models, child, log, turn, prompt-stream, usage, tools.
- **Ported:** the events and consume tests move to `translate.test.ts`.
- **Deleted:** stream, bridge, provider, index, mirror, capture, recorder, transcript.
- **New:** sync, machine, prompt, tool guidelines in MCP descriptions, summary routing, and an index wiring test for the remaining handlers.
- **Live:** the existing nine tests, with the parser reading `sync:` lines.
