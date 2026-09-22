# Turn-recap configuration

Timing, counters, and the persistent card work without configuration. To enable LLM catch-up text, create `<agent-dir>/turn-recap.json`, normally `~/.pi/agent/turn-recap.json`:

```json
{
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinking": "low"
}
```

Use a model already available to Pi with working authentication. The format is strict: model strings must be non-empty and unknown fields are rejected. There is no active-model fallback, project override, or automatic config creation.

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It defaults to `off`, independently of the conversation's thinking level. Pi clamps it to the recap model's supported levels and maps it to provider-native options. Models requiring reasoning may clamp `off` upward.

The file is read at session start/reload. Reload Pi after editing it. A missing file is normal and disables only generated text. Invalid configuration produces a startup notification; the card and statistics continue working. Model lookup and authentication happen on each recap request through Pi. A failed lookup or authentication affects only that attempt; logging in or restoring model availability can recover on the next run without reloading the extension.

## Card behavior

The TUI card stays above the editor. It shows live active duration, start time, tool calls, and reported tokens. On settlement it immediately freezes the counters and shows finish time, including failed and aborted runs. Retries, compaction, steering, and queued follow-ups before settlement belong to the same run.

`/turn-recap` toggles details without opening a dialog or taking editor focus. Details include input/output/cache/reasoning tokens, reported cost, model names, assistant response count, tool errors, compactions, wall/waiting time, and estimated context usage when available. The card is limited to five rendered rows when compact and twelve when expanded, never more than half the terminal height. Current recap status and expanded failure explanations take priority over previous recap text and secondary diagnostics. Lower-priority content is clipped with an ellipsis; narrow or short terminals may not show every diagnostic. Text is normalized into single paragraphs, including restored recaps and errors.

Blocking extension questions pause active time, but wall time continues. Asynchronous questionnaires do not pause active time. Waiting time means time spent in blocking extension UI, not provider latency, tool execution, retry backoff, or compaction.

Token counters update at persisted response/tool boundaries, not by estimating streamed text. The total includes input, output, cache reads, and cache writes across the run; it is not context size. Reasoning tokens are a subset of output and are never added twice. Partial reasoning coverage is labeled. Tools/summaries are included only when they report usage. Reported cost is Pi/provider accounting, not a billing guarantee; a zero can reflect unavailable pricing.

Tool calls count calls issued in assistant messages, including calls that fail, are blocked, or are subsequently cancelled. Tool errors count persisted error results. Counts do not inspect arbitrary work performed inside a tool, such as nested Code Mode calls or independent subagents. Model names are shown where usage is attributed; tool and compaction usage may lack model attribution.

## Generated text

The recap is a recent-conversation catch-up: objective, progress, next step or blocker. The previous successful recap stays visible and labeled while a new run is active or a fresh recap is pending/unavailable. A completed recap replaces it in the same card.

Recap selects the newest eligible projected user/assistant text, respecting compaction and context edits, and presents it chronologically. It excludes tool output, failed/aborted assistant text, compaction summaries, and earlier recap entries. The complete prompt is bounded to 12,000 UTF-16 code units, including instructions, role labels, excerpt markers, and the latest run's outcome. Messages may be excerpted and older text omitted; this is a best-effort catch-up, not a complete history. The budget is not a token-fit guarantee. The request asks for at most 40 words and the result is normalized into one paragraph capped at 320 Unicode characters.

The secondary request has no tools, uses independent request state, and has a hard 30-second timeout. It is attempted once per settled run. Provider context overflow, other provider failures, and unusable responses leave the stats intact and show an unavailable state; details expose the sanitized failure. The next run can try again. Stats-only operation skips recap-specific history projection and prompt construction; Pi may still project history to calculate context statistics. Recap tokens and reported cost appear separately in details and never inflate run counters.

Starting another run cancels pending recap generation. Session/branch changes and shutdown also cancel it. Late results cannot replace the current card. The last completed card is restored from the active session branch after reload; unfinished recap requests restore as interrupted and are not automatically retried. No live in-progress timing is recovered after a process crash.

## Replacement of recap and timer

Turn-recap replaces both extensions. Remove the old extension paths/packages from your Pi configuration and load only turn-recap. If you want generated text, create `turn-recap.json` with the model settings previously used for recap. There is no `recap.json` fallback.

Old session files are never rewritten. Old recap entries remain in those files but are not interpreted or rendered by turn-recap. New snapshots do not render as transcript cards or enter model context. Non-TUI modes still record run snapshots, but do not mount a widget or animate a timer.
