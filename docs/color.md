# Color

Extensions color terminal output only through Pi's theme tokens, chosen by meaning. Never emit raw color escapes, hex values, or a color library; the user's theme decides every hue.

The tone vocabulary and the usage ramp live in `@clanker-stuff/pi-tones` (`pi/packages/tones`). Protocol boundaries use its `ToneSchema` and `Tone`; usage meters use its `percentTone`. Code that picks among a few tones annotates exactly those tones, so the type says what that code can produce and a policy change visits every site it lands on.

## Quiet at rest

A surface the user sees all session, such as the footer or the editor border, is neutral when nothing needs attention. Hue appears for the active mode, for something live, and for something wrong. If every segment is colored, none of them is.

## Tones

| Tone      | Means                                                         | Examples                                           |
| --------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `text`    | Primary value                                                 | Branch name, percent below the warning threshold   |
| `muted`   | Secondary content, and work that was stopped on purpose       | cwd, model, ids, durations, `■ cancelled`          |
| `dim`     | Chrome the user reads past                                    | Separators, icons, key hints, meter tracks, clocks |
| `accent`  | The active mode, the thing that is live, or the call's target | `INSERT`, `code`, `● running`, a tool call's path  |
| `success` | Finished well                                                 | `✓ completed`                                      |
| `warning` | Needs the user                                                | Meter at 70%, questionnaire waiting                |
| `error`   | Failed                                                        | Meter at 90%, `✗ exit 1`                           |

Routine states are never `warning`. A dirty working tree, a running task, an enabled mode, and a cancelled task are all normal; none of them asks the user for anything.

## Shared ramps

- Usage meters use `percentTone(percent)`: `text`, then `warning` from 70, then `error` from 90.
- Lifecycle rows are `accent` while running, `success` or `error` when finished, and `muted` when cancelled or idle.
- Separators and rule-glyph meter tracks (`─`) are `dim`. Block-fill tracks (`░`) use `scrollbarTrack`, which themes keep quieter than `dim`.
- Pi's purpose-built tokens, such as `thinking*` and `bashMode`, belong to Pi's own surfaces. Extensions do not use them.

## Chrome

- Frames and rules use the border tokens, never `accent`: `border` for a frame, `borderAccent` for a focused frame or a titled rule, `borderMuted` for an unfocused frame or a divider.
- A tool call line is `toolTitle` in bold followed by its target in `accent`. A row that names the same target again uses `text`.
- A selected row is `selectedBg`.

## Emphasis without color

`Theme` also offers `bold` and `italic`. Reach for them before spending a hue: bold for a heading or the primary value in a row, applied outside `fg`.

## Fallbacks

A producer that falls back to `ctx.ui.setStatus()` when its host extension is absent publishes plain text. Pi renders that row `dim`, and the footer extension passes native statuses through unchanged.
