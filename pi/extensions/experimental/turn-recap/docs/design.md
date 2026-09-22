# Turn-recap design

Turn-recap combines run accounting, live timing, and optional conversation catch-up in one pinned TUI widget. It uses the public Pi 0.87.0 extension APIs and does not replace the editor or footer.

## Responsibilities

- `index.ts`: command, event, and inter-extension bus registrations.
- `runtime.ts`: session/run lifecycle, widget ownership, persistence, and request freshness.
- `timing.ts`: monotonic active/wall timing and duration formatting.
- `metrics.ts`: raw-entry usage and activity accounting.
- `entry.ts`: strict persisted snapshots and active-branch restoration.
- `card.ts`: width-safe, theme-aware compact/expanded display.
- `conversation.ts`: bounded projected conversation selection and safe recap normalization.
- `recap.ts`: explicit model resolution and isolated, timeout-bounded completion.
- `config.ts`: optional strict global configuration.

## Run lifecycle

```text
session_start -> restore last completed snapshot; mount widget; load optional configuration
agent_start   -> start timing/counters; retain previous successful recap
               -> repeated starts continue the same run through automatic recovery
UI prompt     -> pause/resume active time (except asynchronous questionnaires)
turn/tool/compaction boundaries -> refresh raw-entry metrics
agent_settled -> stop timing; persist/show final stats immediately
               -> optional background recap request
recap result  -> append updated snapshot; repaint same widget
```

`agent_settled`, not Pi's per-response `turn_end`, defines the completed run. Boundary outcomes and the captured abort signal distinguish completion, failure, and interruption. A `continue` proposal from another extension does not freeze the card early. The timer uses `performance.now()` for durations; `Date.now()` is used only for start/finish timestamps.

The run captures the active leaf at its first `agent_start`. Metrics inspect raw branch entries after that leaf, so prior runs and idle usage are excluded, and context edits/compaction do not erase spent tokens. Refreshes happen at lifecycle boundaries, not on animation ticks. Assistant tool-call blocks count issued calls; persisted tool results provide errors and optional nested LLM usage. Summary and attributed usage entries are included when present. There is no inference of hidden tool or subagent work.

The widget uses `setWidget()` and its supplied TUI's `requestRender()`. Rendering is capped at five compact or twelve expanded rows, further limited to half the current terminal height. Text is normalized into paragraphs; clipped content ends with an ellipsis. Current recap status, including the failure explanation when expanded, precedes previous recap text and secondary diagnostics. It reads current state during rendering, so theme invalidation and terminal resizing do not retain stale styled strings. It never takes keyboard focus. `/turn-recap` toggles diagnostics. Session shutdown clears the interval, request, widget, and owned references.

## Persistence

`pi.appendEntry("@clanker-stuff/turn-recap", snapshot)` stores a completed run's ID, timestamps, durations, outcome, metrics, and recap state. Stats and timing are finalized and written before optional prompt preparation. Without usable recap configuration, settlement skips recap-specific projection and prompt construction. Context statistics still call Pi's `getContextUsage()`, which may build a session projection. A result appends a second full snapshot with the same run ID; this is an append-only update, not a JSONL rewrite.

Snapshots have no entry renderer, do not enter model context, and do not appear as repeated transcript cards. Restoration validates only the new schema, folds updates on the active branch, and finds the preceding successful recap. A persisted pending request becomes an interrupted display state after reload; no request or timer is resurrected. Partial timing for a process that crashed during work is intentionally not reconstructed.

## Recap isolation and freshness

The configured secondary model is called through Pi's registry with no tools/system prompt, a fresh session ID, and no cache retention. Thinking is explicit and never inherited. Model lookup happens on every request; Pi handles request-time authentication. Neither failure permanently disables later recaps. Projected entries honor omissions/replacements and compaction boundaries. Recent eligible messages are selected newest-first within a 12,000 UTF-16-code-unit prompt budget and emitted chronologically, with marked excerpts when needed. Instructions and run outcome are included in that budget. Older details can be omitted; this is a best-effort catch-up rather than a full-history summary.

The character budget is not a token-fit guarantee; provider context overflow remains a request failure. Only a `stop` response with nonempty sanitized text is accepted. The provider signal, hard deadline, and abort race also release the extension when a provider ignores cancellation. Reported recap usage is kept separately, including failed responses when usage is available.

A new run, session replacement, tree navigation, or shutdown invalidates and aborts pending work. A completion must still own the request/session and match the captured projected prompt while Pi is idle. Failures are snapshot-local, not a reason to disable the next run. The runtime returns a completion promise covering preparation, generation, and result processing. The Pi event handler deliberately does not await it; tests await that promise rather than counting microtasks. No extension-level retries, compatibility adapters, global history store, or transcript mutation are required.

See [configuration](configuration.md) for user-facing semantics and accounting limitations.
