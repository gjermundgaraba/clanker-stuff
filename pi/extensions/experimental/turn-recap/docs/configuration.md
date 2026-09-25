# Turn-recap configuration

Live counters and transcript cards work without configuration. To enable LLM catch-up text, create `<agent-dir>/turn-recap.json`, normally `~/.pi/agent/turn-recap.json`:

```json
{
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinking": "low"
}
```

Use a model already available to Pi with working authentication. The format is strict: `model` is required, its provider and id must be non-empty and are matched exactly as written, and unknown fields are rejected. A mistyped id shows as a recap failure on each card. Without the file, generated text is disabled. There is no active-model fallback, project override, or automatic config creation.

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It defaults to `off`, independently of the conversation's thinking level. Pi clamps it to the recap model's supported levels and maps it to provider-native options. Models requiring reasoning may clamp `off` upward.

The file is read at session start/reload. Reload Pi after editing it. A missing file is normal: cards and statistics work without generated text. Invalid configuration produces a startup notification and disables only generated text. Model lookup and authentication happen on each recap request through Pi. A failed lookup or authentication affects only that attempt; logging in or restoring model availability can recover on the next run without reloading the extension.

## Live row and transcript card

While a run is active, one row above the editor shows active duration, tool calls, and separate processed/context counters. The editor's working indicator shows liveness, so the row has no status label. The row disappears when the run settles, so nothing sits above the editor between runs. Retries, compaction, steering, and queued follow-ups before settlement belong to the same run.

Each run adds one card to the chat as soon as it settles, below the run's last message. Its heading names the outcome with the active duration and finish time: completed, failed, or aborted. The recap, when there is one, comes first, then a blank row, then the counters. While a recap model works, the card shows "Generating recap…" in the recap's place, and the recap replaces it in the same card when it arrives. Cards follow the active branch. A recap that finishes after the next prompt or after tree navigation is saved later than its card, possibly on another branch. Forks copy only the forked path, so a fork that does not include the recap entry shows its card without a recap. Like everything else in the chat, cards from before a compaction leave the view once Pi redraws the chat after compacting or reloading; their entries stay in the session file. Cards never enter model context.

The live row shows whole seconds and simply freezes while paused. Finished cards show tenths below a minute and `m:ss` above; rounding to tenths happens before selecting the notation, so a rounded minute displays as `1:00`.

Pi's tool-output toggle (`Ctrl+O` by default) expands every card. Details include input/output/cache/reasoning tokens, reported cost, recap-generation usage, model names, assistant response count, tool errors, compactions, and wall/waiting time. Context appears once: details add the current size, capacity, and percentage to the counter. A failed recap shows one truncated row until expanded. Recaps and errors are normalized into single paragraphs; persisted errors are capped at 1,000 characters.

Blocking extension questions pause active time, but wall time continues. Asynchronous questionnaires do not pause active time. Waiting time means time spent in blocking extension UI, not provider latency, tool execution, retry backoff, or compaction.

Token counters update at persisted response/tool boundaries, not by estimating streamed text. **Processed** includes reported input, output, cache reads, and cache writes across the run. **Context** is the growth of Pi's estimated context size since the run started, not cumulative usage; details also show the current size, capacity, and percentage, and the counter's color follows that percentage. It starts at `+0` and turns negative when compaction shrinks the context. Pi knows no size after compaction until the next response, so a run starting there measures from its first known size. Before a session's first response Pi can only estimate messages, so the first run's growth may include tool definitions. Unknown or unavailable measurements are not shown as zero. Reasoning tokens are a subset of output and are never added twice. Partial reasoning coverage is labeled. Tools/summaries are included only when they report usage. Reported cost is Pi/provider accounting, not a billing guarantee; a zero can reflect unavailable pricing.

Tool calls count calls issued in assistant messages, including calls that fail, are blocked, or are subsequently cancelled. Tool errors count persisted error results. Counts do not inspect arbitrary work performed inside a tool, such as nested Code Mode calls or independent subagents. Model names are shown where usage is attributed; tool and compaction usage may lack model attribution.

### Rolling numbers

The live row can roll its digits using a locally generated companion font mapped to private-use characters by your terminal. The row animates whenever `<agent-dir>/data/turn-recap/rolling-font/manifest.json` exists, and building the font writes it, so [build, install, and preview the font](rolling-font.md) before reloading Pi. There is no setting: delete or rename the manifest and reload Pi to return to ordinary digits. Reload Pi after rebuilding, too.

Pi cannot detect terminal fonts, so missing-glyph boxes mean the font or mapping is incomplete or stale. An invalid manifest disables only animation and produces a notification. Only the live row animates, and settled values are ordinary digits; copying during motion may capture private-use characters.

## Generated text

The recap is a recent-conversation catch-up: objective, progress, next step or blocker. The card and its statistics are saved before the request starts; the recap is saved separately when it arrives or fails and appears inside its card, including after a reload.

Recap selects the newest eligible projected user/assistant text, respecting compaction and context edits, and presents it chronologically. It excludes tool output, failed/aborted assistant text, compaction summaries, and earlier recap entries. The complete prompt is bounded to 12,000 UTF-16 code units, including instructions, role labels, excerpt markers, and the latest run's outcome. Messages may be excerpted and older text omitted; this is a best-effort catch-up, not a complete history. The budget is not a token-fit guarantee. The request asks for at most 40 words and the result is normalized into one paragraph capped at 320 Unicode characters.

The secondary request has no tools, uses independent request state, and has a hard 30-second timeout. It is attempted once per settled run. Provider context overflow, other provider failures, and unusable responses leave the stats intact and show an unavailable state; details expose the sanitized failure. The next run can try again. Stats-only operation skips recap-specific history projection and prompt construction; Pi may still project history to calculate context statistics. Recap tokens and reported cost appear separately in details and never inflate run counters.

Recaps keep generating while you start another run or navigate the session tree, and each fills in its own card; several can be in flight at once. A recap that finishes after tree navigation is saved on the branch you are on, where it stays hidden and out of model context. Shutting down (quit, reload, or session replacement) abandons pending recaps; those cards keep no recap. A crash while a recap is pending loses only the recap. No in-progress timing is recovered after a crash.

## Replacement of recap and timer

Turn-recap replaces both extensions. Remove the old extension paths/packages from your Pi configuration and load only turn-recap. If you want generated text, create `turn-recap.json` with the model settings previously used for recap. There is no `recap.json` fallback.

Old session files are never rewritten. Entries from older recap and turn-recap versions remain in those files but are not rendered. Non-TUI modes still record run cards, but do not mount the live row or run timers.
