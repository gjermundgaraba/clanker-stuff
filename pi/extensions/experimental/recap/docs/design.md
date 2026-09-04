# Recap design and Codex reference

Reference research and implementation contract for the experimental Pi extension modeled on Codex's **Conversation recap** feature.

## Reference snapshots

- Codex: `openai/codex` `origin/main` at `389dd5645944891b65e4ca584125bbb0c852d352`, inspected 2026-09-03.
- Pi: `earendil-works/pi` tag `v0.84.4` at `b79e4cc834970cca69daebffab7df1da7d1e52c4`.

Codex introduced the feature in three commits:

- `7c1e36c23f` — prepare focus tracking, eligibility, bounded history, and rendering (#40696).
- `40ba7da7b4` — add scheduling, isolated structured requests, stale-result rejection, and retry (#40697).
- `6988d390b3` — enable automatic generation and `/recap` (#40705).

Codex later added one recap-specific preference:

- `8ea297ff60` — add `tui.auto_recap`, enabled by default, to disable automatic generation while keeping `/recap` available (#42101).

Apart from this opt-out gate, the refresh found no changes to the recap algorithm described below.

## What the feature is

Conversation recap is a short, display-only catch-up for a person returning to a task. It is not Codex's `/compact` feature:

- it does not replace or summarize model context;
- it does not become a message in the visible thread;
- it does not affect the next agent turn; and
- it only adds a local `Conversation recap` card to the TUI transcript.

The summary describes the objective, recent progress, and the next step or blocker. Codex targets at most 40 words in one or two plain-text sentences.

## Codex user experience

### Manual recap

`/recap` generates immediately when the displayed thread is idle and has textual conversation history. It bypasses the automatic thresholds for terminal focus, completed turns, delay, and turns since the previous recap.

While it runs, Codex shows an animated `Generating conversation recap…` cell. It clears that cell before inserting the result, reporting an error, or accepting a new user message.

Manual failures are visible and are not retried:

- the session is still starting;
- the current task is still running;
- another recap is already in flight;
- there is no eligible conversation history; or
- generation failed.

### Automatic recap

Automatic recap is enabled by default. Setting `tui.auto_recap` to `false` cancels scheduled checks, rejects new automatic requests, and discards pending automatic results without retrying. It does not disable manual `/recap`.

Codex schedules a recap only when all of these are true:

- the terminal is unfocused;
- the thread is the one currently displayed;
- no user turn is pending or running;
- at least three turns have completed successfully;
- at least two successful turns have completed since the previous recap; and
- three minutes have passed since both the latest focus loss and the latest finished turn.

In other words, the deadline is:

```text
max(unfocused_since, last_turn_finished_at) + 3 minutes
```

A failed or interrupted turn does not increase the completed-turn count, but it does advance the revision and restart the three-minute quiet period. Repeated focus-loss events do not restart the timer.

Automatic generation has no loading cell. A failure is logged and retried once, 30 seconds later, provided the conversation revision has not changed. Regaining focus cancels automatic eligibility and makes any eventual result stale; manual requests survive focus changes.

On non-Windows platforms, Codex enables crossterm focus reporting and maps terminal focus events into `TuiEvent::FocusGained` and `TuiEvent::FocusLost`. Focus reporting is disabled on Windows, so the manual command remains the reliable path there.

## Generation pipeline

The end-to-end flow is:

```text
FocusLost or /recap
  -> CheckRecap or GenerateRecap
  -> capture bounded visible history
  -> start hidden ephemeral thread
  -> RecapStarted
  -> run one structured turn
  -> RecapGenerated
  -> validate freshness
  -> insert local Conversation recap cell
```

The work is deliberately split around app events so thread creation and model generation do not block the TUI event loop.

### History selection

Codex walks the current TUI transcript from newest to oldest and keeps only:

- user message cells;
- completed assistant Markdown cells; and
- completed or currently assembled assistant message cells.

It ignores tool activity, status and error notices, loading cells, empty messages, and previous recap cards. It stops after the eighth most recent user message, then restores chronological order.

The full prompt is capped at 900 UTF-8 bytes. The fixed instructions consume 534 bytes in the inspected version, leaving 366 bytes for history. Half of the history budget is reserved for the latest user message; the remaining budget is filled newest-first. Truncation uses UTF-8 character boundaries.

### Prompt

Codex sends this fixed prefix followed by the selected history:

```text
Write a brief catch-up for a user returning to this Codex task. In at most 40 words and one or two plain-text sentences, explain the objective, what was completed or learned, and the next step or blocker. Mention changed files, tests, approvals, or requested decisions only when relevant. Never claim changes were made or tests passed unless the conversation confirms it. If the task is complete, say so instead of inventing more work. Use the user's language; omit greetings, markdown, lists, and tool chatter.

Recent conversation:
```

History messages are labeled `User:` and `Assistant:` with a blank line between messages.

### Output contract

The temporary turn requests JSON matching:

```json
{
  "type": "object",
  "properties": {
    "recap": {
      "type": "string",
      "minLength": 1,
      "maxLength": 320
    }
  },
  "required": ["recap"],
  "additionalProperties": false
}
```

Codex parses the final assistant message, trims it, rejects invalid JSON or an empty recap, and defensively caps the result at 320 characters. The 40-word and two-sentence limits are prompt instructions rather than parser checks. The shared structured-response collector also rejects responses over 8 KiB.

## Isolation and safety

Recap generation uses the visible thread's current model, provider, working directory, and active permission profile, but not the visible thread itself. Codex starts a hidden app-server thread with:

- `ephemeral: true` and a system-feature source;
- approval policy `Never`;
- read-only sandboxing unless an existing custom permission profile must be preserved;
- no runtime workspace roots or environments;
- no dynamic or built-in tools;
- no apps, code mode, hooks, memories, skills, subagents, shell, image, or web-search features; and
- every locally known and remote-effective MCP server explicitly disabled.

The effective configuration is read before thread creation. Failure to discover it fails closed. Codex also verifies that the temporary thread actually received the expected read-only or custom permission profile.

Thread creation and the structured turn each have a 30-second timeout. The response collector accepts only agent messages and the completion event for the requested turn. Temporary-thread notifications are quarantined from normal thread routing, and Codex makes a bounded best-effort unsubscribe after completion, failure, timeout, or staleness.

## Freshness and concurrency

Each request captures:

- the visible thread ID;
- a unique request ID;
- whether the trigger was automatic or manual;
- the completed-turn count; and
- a revision incremented by every finished turn, including failed turns.

Codex checks these values after the temporary thread starts and again after the recap is generated. It discards the result if the user changed threads, a turn started or finished, the request was superseded, focus invalidated an automatic request, or the temporary thread does not match. This prevents a plausible but outdated recap from entering the transcript.

Only one recap can be in flight for the displayed conversation.

## Rendering and persistence

The result renders as a wrapping checkpoint-style card:

```text
─ Conversation recap ─────────────────────────

  Finished the parser. Next: run focused tests.
```

Raw transcript export retains the `Conversation recap` heading and body.

The card is only a Codex TUI history cell. It is not written to the app-server thread or rollout, is not sent to the model, and is explicitly excluded from later recap input. It can remain in terminal scrollback, but it is not reconstructed from the server after a process restart. The completed-turn and last-recapped counts survive in-process thread switching through the TUI's thread-event cache; the last-recapped count is not durable across process restarts.

## Codex source map

| Area                                                                            | Source                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Policy, prompt, history bounds, request lifecycle, freshness, retry, state      | `codex-rs/tui/src/app/recap.rs`                                                           |
| Automatic-recap preference                                                      | `codex-rs/config/src/types.rs`, `codex-rs/tui/src/local_settings.rs`                      |
| Hidden structured thread, tool isolation, timeout, response collection, cleanup | `codex-rs/tui/src/temporary_structured_request.rs`                                        |
| Terminal focus enable/disable and TUI focus events                              | `codex-rs/tui/src/tui.rs`, `codex-rs/tui/src/tui/event_stream.rs`                         |
| Focus and turn-finish scheduling                                                | `codex-rs/tui/src/app.rs`, `codex-rs/tui/src/app/thread_routing.rs`                       |
| App-event routing and final insertion                                           | `codex-rs/tui/src/app_event.rs`, `codex-rs/tui/src/app/event_dispatch.rs`                 |
| Hidden notification quarantine                                                  | `codex-rs/tui/src/app/app_server_events.rs`                                               |
| `/recap` registration and dispatch                                              | `codex-rs/tui/src/slash_command.rs`, `codex-rs/tui/src/chatwidget/slash_dispatch.rs`      |
| Manual loading state                                                            | `codex-rs/tui/src/chatwidget/recap.rs`, `codex-rs/tui/src/chatwidget/input_submission.rs` |
| Recap and loading cells                                                         | `codex-rs/tui/src/history_cell/notices.rs`                                                |
| Unit and rendering tests                                                        | `codex-rs/tui/src/app/recap_tests.rs`, `codex-rs/tui/src/history_cell/tests.rs`           |
| End-to-end request tests                                                        | `codex-rs/tui/src/app/tests/recap_generation_tests.rs`                                    |

## Selected Pi extension design

The Pi extension retains Codex's turn thresholds, prompt policy, bounded-history shape, request isolation, freshness checks, and rendering while deliberately adapting its trigger, persistence, history fitting, and terminal failure behavior:

- generation is automatic only; the extension does not register `/recap` or another manual trigger;
- each `agent_settled` event immediately checks eligibility and starts generation when eligible;
- the first recap requires three completed turns and later recaps require two more completed turns;
- the result is a durable, display-only inline custom entry; and
- generation requires an explicitly configured secondary model and never falls back to the active model.

The refreshed Codex snapshot leaves these algorithmic choices aligned. The extension does not mirror `tui.auto_recap`: loading this experimental extension is already an opt-in to automatic recaps, and unlike Codex it has no manual recap command to preserve when automatic generation is disabled. Leaving the extension unloaded is the corresponding opt-out.

There is no focus requirement or three-minute delay. `agent_settled` guarantees that Pi has no automatic retry, compaction, or queued continuation left, but it does not mean the terminal is unfocused. This is an intentional product difference rather than an emulation of Codex's focus behavior.

### Required configuration

The file format and operating instructions are documented in
[Recap configuration](configuration.md). The design deliberately requires one
explicit global secondary model: the extension does not create the file,
choose a default, fall back to `ctx.model`, provide a project override, or
include a configuration editor. Pi's model registry does not expose comparable
price data, so “cheaper” remains a user choice.

### Turn accounting and eligibility

At each `agent_settled`, the extension derives progress from the active branch returned by `ctx.sessionManager.getBranch()`:

- a user turn counts as completed when its final assistant message has stop reason `stop` or `length`;
- `error`, `aborted`, and an incomplete `toolUse` sequence do not count;
- the first recap is eligible at three completed turns; and
- after a recap, another is eligible when the completed-turn count is at least two greater than the count stored in the latest recap entry on the active branch.

Deriving the counts from the branch makes resume and fork behavior deterministic. The durable recap entry stores the completed-turn count at which it was created, so a process restart does not reset the two-turn threshold. A recap on another branch is not considered.

Generation also requires valid configuration, non-empty eligible history, an idle current session, and no recap already in flight. The `agent_settled` handler starts background work and returns instead of blocking Pi's settled lifecycle on a model request.

The selected Pi pipeline is:

```text
agent_settled
  -> derive completed-turn progress from the active branch
  -> require 3 completed turns, then 2 since the latest recap
  -> capture bounded user and assistant text from retained post-compaction history
  -> call the configured secondary model in isolation
  -> validate session, conversation, and captured prompt freshness
  -> append a durable display-only Conversation recap entry
```

### Model input and output

Lifetime turn and recap accounting uses the full active branch so compaction does not reset the durable cadence. History construction instead uses `ctx.sessionManager.buildContextEntries()` to respect Pi's retained-message boundary after compaction, while deliberately omitting the compaction summary itself. It follows Codex's bounds:

- walk that compaction-aware context newest-first;
- keep non-empty user text and assistant text while ignoring tool results, tool calls without text, errors, notices, compaction summaries, and earlier recaps;
- stop after the eighth most recent user message, then restore chronological order;
- cap the complete prompt at 900 UTF-8 bytes;
- reserve half of the available history budget for the latest user message;
- fill the remainder newest-first, truncating the final included message and stopping once no labeled content fits; and
- truncate only at UTF-8 character boundaries.

Messages use `User:` and `Assistant:` labels with a blank line between them. The extension uses Codex's fixed prompt with only the product name changed:

```text
Write a brief catch-up for a user returning to this Pi task. In at most 40 words and one or two plain-text sentences, explain the objective, what was completed or learned, and the next step or blocker. Mention changed files, tests, approvals, or requested decisions only when relevant. Never claim changes were made or tests passed unless the conversation confirms it. If the task is complete, say so instead of inventing more work. Use the user's language; omit greetings, markdown, lists, and tool chatter.

Recent conversation:
```

The prompt prefix's actual UTF-8 length is subtracted from the 900-byte limit rather than assuming Codex's 366-byte history budget.

Pi's provider-independent completion API does not expose JSON Schema output, so the extension requests plain text rather than Codex's `{ "recap": string }` envelope. It accepts only a completed `stop` response; `length` is valid for counting a conversation turn but is rejected for recap output because it may be truncated. The extension extracts the response text, removes terminal and bidirectional control characters, trims it, rejects an empty result, and caps it at 320 Unicode characters. The 40-word and two-sentence limits remain prompt instructions.

### Isolation, freshness, and retry

The configured model is resolved with `ctx.modelRegistry.find()` and called through `ctx.modelRegistry.complete()` with a fresh session ID, no system prompt or tools, no active-conversation messages, no cache retention, and an output budget of up to 4,096 tokens capped by the model's limit. The runtime enforces a hard 30-second deadline while also passing the provider an abort signal and timeout. Direct completion already isolates the request from Pi's agent loop, so the extension does not need Codex's hidden app-server thread or sandbox configuration.

Each request captures completed-turn progress, the latest user-or-assistant entry ID as its conversation revision, and the exact compaction-aware prompt. The Pi session state and in-flight `AbortController` provide session and request identity. Before appending the result, the extension rebuilds both views and rejects the response if:

- the session was replaced or shut down;
- another request superseded it;
- a user turn started or settled;
- the conversation revision changed; or
- compaction or another context change altered the captured prompt.

Only user and assistant conversation entries contribute to the revision, so an unrelated display-only custom entry does not make a valid recap stale. `agent_start`, `session_tree`, session replacement, and shutdown abort any in-flight request and retry timer.

Like Codex automatic recap, generation has no loading cell. A failed request is retried once after 30 seconds if the session, conversation revision, and captured prompt are unchanged. A second failure produces one warning and disables recap generation until the session is started or reloaded, avoiding repeated requests to a model that cannot produce a usable recap.

### Durable inline entry

On success, `pi.appendEntry()` stores a custom entry with type `@clanker-stuff/recap` containing:

```json
{
  "completedTurns": 3,
  "recap": "Finished the parser. Next: run focused tests."
}
```

`pi.registerEntryRenderer()` renders the same wrapping `Conversation recap` checkpoint card as Codex. Recap text is sanitized before persistence and again at the rendering boundary so imported or hand-authored entries cannot emit terminal or bidirectional controls. The entry is part of the Pi session JSONL and reappears after restart, but it does not participate in model context. History selection explicitly ignores these entries so recaps never summarize earlier recaps.

The extension remains separate from compaction while respecting its resulting context boundary. It does not use `session_before_compact`, summarize the compaction entry itself, alter `context`, or call `sendMessage()`.

### Remaining Pi differences

Pi v0.84.4 has no supported extension event or context field for terminal-window focus changes. `ctx.ui.onTerminalInput()` is not an equivalent:

- regular-screen Pi does not enable terminal focus reporting; and
- fullscreen Pi enables focus reporting as part of its mouse mode, but its viewport listener consumes `ESC [ I` and `ESC [ O` before extension input listeners receive them.

The selected `agent_settled` trigger therefore runs while the terminal may still be focused, and it runs immediately rather than after Codex's three-minute quiet period.

Pi also has no public API for inserting a non-persistent local transcript cell. The selected custom entry is inline and display-only like Codex's card, but deliberately durable in the session JSONL.
