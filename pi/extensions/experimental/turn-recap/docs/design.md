# Turn-recap design

Turn-recap combines run accounting, live timing, and optional conversation catch-up. A one-row TUI widget exists only while a run is active; each settled run becomes one transcript card through an entry renderer, and its recap fills in that card when it arrives. It uses the public Pi 0.87.1 extension APIs and does not replace the editor or footer.

## Responsibilities

- `index.ts`: entry renderer, event, and inter-extension bus registrations.
- `runtime.ts`: session/run lifecycle, widget mounting, persistence, and the recap lookup cards render from.
- `timing.ts`: monotonic active/wall timing and duration formatting.
- `metrics.ts`: raw-entry usage and activity accounting.
- `entry.ts`: the strict card and recap entry schemas.
- `card.ts`: width-safe, theme-aware live row, transcript card, and the cached card component Pi's entry renderer returns.
- `conversation.ts`: bounded projected conversation selection and safe recap normalization.
- `recap.ts`: explicit model resolution and isolated, timeout-bounded completion.
- `config.ts`: optional strict global configuration.
- `font.ts`: validates the local manifest and samples its private-use glyph frames.
- `rolling.ts`: display-only digit motion and inline glyph substitution.
- `widget.ts`: the live row's only redraw timer, animation, and disposal.

## Run lifecycle

```text
session_start       -> index saved recaps by run ID; load optional configuration and rolling font
agent_start         -> start timing; mount a fresh widget (pending recaps keep generating)
                    -> repeated starts continue the same run through automatic recovery
UI prompt           -> pause/resume active time (except asynchronous questionnaires)
turn/tool/compaction boundaries -> refresh raw-entry metrics
agent_settled       -> stop timing; unmount; write the card
                    -> with a recap model, mark it generating and request the recap in the background
recap result        -> write the recap entry; its card redraws with it
session_shutdown    -> abort pending recaps and clear state
```

`agent_settled`, not Pi's per-response `turn_end`, defines the completed run. Boundary outcomes and the captured abort signal distinguish completion, failure, and interruption. A `continue` proposal from another extension does not freeze the card early. The timer uses `performance.now()` for durations; `Date.now()` is used only for start/finish timestamps.

The run captures the active leaf at its first `agent_start`. Metrics inspect raw branch entries after that leaf, so prior runs and idle usage are excluded, and context edits/compaction do not erase spent tokens. Refreshes happen at lifecycle boundaries, not on animation ticks. Assistant tool-call blocks count issued calls; persisted tool results provide errors and optional nested LLM usage. Summary and attributed usage entries are included when present. There is no inference of hidden tool or subagent work.

The widget uses `setWidget()` and its supplied TUI's `requestRender()`. It is one truncated row without a heading, leaving liveness to the editor's working indicator, and is removed between runs. It reads current state during rendering, so theme invalidation and terminal resizing do not retain stale styled strings. It never takes keyboard focus.

The transcript card is a pure function of its entry and Pi's tool-output expansion. Text is normalized into paragraphs and wraps without a row limit; recaps and persisted errors are length-bounded at creation instead. Entries that fail the current schema, including those written by earlier versions, render nothing.

## Numeric rendering

`card.ts` returns ordinary text lines. In the live row, at each numeric source, an optional `(id, formattedText) => displayedText` callback supplies the display value before theme styling and truncation. Transcript cards never animate, so prose and model names have no path into that callback. Both ordinary digits and companion-font frames occupy one terminal cell, so they use the same layout path without column metadata or ANSI splicing.

`rolling.ts` tracks requested formatted values by stable field ID. All fields share the same observation-driven motion policy: a newly observed field snaps to its value, and later changes roll when a render observes them, not at an exact clock boundary. Changed digits travel through intermediate digits at a fixed pace per step, capped so every digit settles within 900 ms; unchanged digits stay still and complete revolutions are omitted. Direction follows the displayed digits, with decimal carries and a five-to-zero carry for time's tens-of-seconds wheel, so negative context growth rolls by its magnitude. Values whose digit layout changes, including sign changes, snap. A new value replaces the transition from its last requested destination rather than queueing a backlog. It reports whether any requested field is still moving, independently of the sampled character; fields not requested by the next render are forgotten. `widget.ts` owns the only timer: it wakes at the frame rate while digits move, otherwise just after the next displayed second, and not at all while paused. Each run mounts a fresh widget, so history never spans runs. Layout changes and nonblocking overlays do not own animation state. A field truncated after formatting may finish its transition offscreen.

`font.ts` owns the standard font storage path, validates the runtime portion of the manifest, and samples its private-use glyph frames. The runtime loads the manifest once at session start whenever it exists, with a session ownership check after the asynchronous read. Each widget receives the font when it mounts; a run that starts while the manifest is still loading keeps ordinary digits. Font and recap configuration load concurrently and fail independently. Reverse motion samples a pair's frames backwards, and a stationary digit (used by the preview) is its outgoing pair's first frame. Frames are supplementary-plane characters, so consumers work in code points, not UTF-16 units; Pi measures each as one cell. The source font, installed companion, and terminal mapping remain outside runtime ownership.

The standalone TypeScript preview drives the same widget with synthetic metrics. Python owns outline construction and is checked by hand rather than by the repository test suite; the optional CoreText diagnostic checks macOS rendering. No animation state is persisted or charged as usage. See [font setup](rolling-font.md) for build and validation commands.

## Persistence

`pi.appendEntry("@clanker-stuff/turn-recap", snapshot)` stores a settled run's ID, timestamps, durations, outcome, and metrics before any recap request starts. A recap is saved separately as `@clanker-stuff/turn-recap/recap` with its run ID. Without usable recap configuration, settlement skips recap-specific projection and prompt construction. Context statistics still call Pi's `getContextUsage()`, which may build a session projection.

Saved entries never change. The card renderer returns a component that looks its recap up in the runtime on every render, so the recap, or "Generating recap…", appears in place. Each component caches its lines until the width or its recap changes. Recap entries have no renderer of their own; writing one makes Pi redraw the transcript, which is the card's update. At session start the runtime indexes every saved recap by run ID. Recaps on other branches are harmless, so tree navigation needs no rebuild. Entries never enter model context. A process crash while a recap is pending loses only the recap; partial timing for a crashed run is intentionally not reconstructed.

## Recap isolation and freshness

The configured secondary model is called through Pi's registry with no tools/system prompt, a fresh session ID, and no cache retention. Thinking is explicit and never inherited. Model lookup happens on every request; Pi handles request-time authentication. Neither failure permanently disables later recaps. Projected entries honor omissions/replacements and compaction boundaries. Recent eligible messages are selected newest-first within a 12,000 UTF-16-code-unit prompt budget and emitted chronologically, with marked excerpts when needed. Instructions and run outcome are included in that budget. Older details can be omitted; this is a best-effort catch-up rather than a full-history summary.

The character budget is not a token-fit guarantee; provider context overflow remains a request failure. Only a `stop` response with nonempty sanitized text is accepted. The provider signal, hard deadline, and abort race also release the extension when a provider ignores cancellation. Reported recap usage is kept separately, including failed responses when usage is available.

Recaps are independent of later runs: each request keeps its own abort controller and fills in only its own card, so several can overlap and tree navigation does not cancel them. A recap finishing after navigation is written at the current leaf; it is keyed by run ID, renders nothing, and stays out of model context. Only shutdown aborts pending requests, and an aborted request writes nothing. A recap is not re-checked against context edits made while it was generated. Failures are card-local, not a reason to disable the next run. The runtime returns a completion promise covering preparation, generation, and result processing. The Pi event handler deliberately does not await it; tests await that promise rather than counting microtasks. No extension-level retries, compatibility adapters, global history store, or entry rewrites are required.

See [configuration](configuration.md) for user-facing semantics and accounting limitations.
