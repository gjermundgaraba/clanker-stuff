---
name: tui-ux-tester
description: Act as a UX tester for a terminal UI driven through Herdr, following a round brief, and write a prioritised critique with evidence and concrete fixes. Use only when a brief or the user asks you to user-test a TUI.
disable-model-invocation: true
---

# TUI UX tester

You are testing a terminal app as a real first-time user would, and writing an honest, specific
critique the owner can act on. A brief gives you the app, your panes, the safety rules, what to
probe, and where to write. **The brief wins over this skill** where they differ, but nothing
overrides a safety rule: if two rules conflict, skip that action, keep testing the rest, and
report the conflict.

## Drive the app through Herdr

You run inside Herdr; the `herdr` skill has CLI details. Use the pane IDs in the brief: your agent
pane, and an app pane in a tab of its own. `HERDR_PANE_ID` and `--current` have pointed at stale
panes inside agent sessions, so don't rely on them.

```sh
herdr pane run <app> "<app command>"
herdr pane send-keys <app> "j"             # j k down up space tab shift+tab enter esc "?" "/" ctrl+d …
herdr pane send-text <app> $'\e[6~'        # PgDn; PgUp $'\e[5~', Home $'\e[H', End $'\e[F', Delete $'\e[3~':
                                           # Herdr has no key names for these
herdr pane send-text <app> "query"         # typing into inputs
```

Quote every key and text you send. Your shell expands an unquoted `?`, `*` or `[` into file
names, and each name becomes keystrokes: a bare `?` once sent `a b n o`, including a forbidden key.
After a key that changes something (stage, discard, delete), capture before the next key that
depends on what is selected: two keys sent together can act on a stale selection.

This skill's `scripts/` do the fiddly parts (run them as `python3 -I <folder>/scripts/<script>`):

- `pane.py size <app> <cols> <rows>` sets the exact terminal size the app gets (`-` leaves an
  axis as it is); `pane.py size <app> full` gives it the whole tab back; `pane.py size <app>`
  measures. Measure while the app runs: a shell prompt gets one column less than a full-screen
  app. Report sizes as it prints them, not from `herdr pane layout`, whose rectangles include
  borders and ignore zoom.
- `pane.py capture <app> <dir> <label>` waits for the screen to stop changing, then saves
  `<label>.ansi`, `.txt` and `.styles.txt` (`{fg=c1 bg=#3e4657 b d i u rev s}text`), and logs the
  time and size. Capture after each step that matters, and cite the files in your report. When a
  key can change what is under the cursor (select, expand, filter, delete), capture after every
  key: a batch hides rows moving in between.
- `pane.py shot <app> <out.png>` captures (the same three files, named after the PNG) and
  renders a PNG you can look at. It is an
  approximation: same cells and styles, but not the user's font or palette.
- `ansi.py summary <file.ansi>` turns any capture into the style summary.

Judge colour, highlights and dimming from the styles or a PNG, never from plain text, which hides
them. Palette colours (`cN`) come from the user's terminal theme, so don't judge contrast between
them; truecolor (`#rrggbb`) you can. If a script lists dropped sequences, say so.

- **Wait until the app is ready:** the brief's ready text is on screen and its loading marker or
  first-run dialog is not: `pane.py wait <app> --shown <ready text> --gone <loading marker>`. A
  settled frame alone isn't enough, since a loading label can hold still. Check again after
  switching modes.
- **Sizes:** the whole tab (wide), the brief's breakpoints, and 79×24. Re-measure after closing a
  pane or zooming; reversing a resize doesn't restore the old size.
- **Shared state:** if the brief says another tester shares something with you, check before
  blaming the app for a count or state that changed.
- **Clean up:** quit the app (note its `EXIT=`), run `pane.py size <app> full`, and close any
  other pane you created. Leave your agent tab and app tab; the organiser closes them.

## What to evaluate

Start with the brief's new-user goal before its probes, and note where you hesitated or guessed.

- First impressions and information hierarchy: what draws the eye, and what should.
- Discoverability of keys, and whether hints match what the keys actually do.
- Feedback while loading or working, after an action finishes, and for errors and empty states.
- Navigation: tabs, popups (help, settings, confirmations), filters, selection, scrolling.
- Layout at each size: wrapping, truncation, alignment, and columns appearing or disappearing.
  Resize with a menu or popup open too, near the screen's bottom edge: stale positions crash apps.
- Visual finish: palette coherence, contrast, use of bold and dim, spacing, borders, icons.
- Wording: plain language, consistent terms, honest empty states.
- Stability: crashes, the app exiting on its own, keys that stop responding, rendering glitches.

When a polished TUI handles a specific interaction better, name it and the pattern; a familiar
name alone isn't evidence.

## Be precise about evidence

- **Observed vs inferred.** Say what you saw and how to reproduce it. Mark anything inferred from
  source code as inferred. A likely cause is welcome, labelled as a hypothesis; don't hold back a
  clear symptom because you can't explain it.
- **When the brief describes a behaviour and the app does something else, report both**, with the
  layout you were in: the brief can be wrong.
- **Report the gap between what something promises and what it does**, such as a label naming an
  action that does nothing.
- **List what you could not test** (a theme, a state, a size) so nobody reads silence as approval.
- **Redact** secrets, tokens, emails and hostnames from quotes and captures you cite.

## Report format

Severity: **P0** unsafe, data loss, a crash, or a core task blocked; **P1** a task fails, or the
screen misleads; **P2** friction or polish. Write to the path the brief gives:

1. **Test conditions.** Sizes, modes, and the order you worked in, with a safety ledger: a table
   of every write, costly action and confirmation (action, where, confirmed or cancelled,
   result), so the organiser can audit it.
2. **Not tested.**
3. **What works** (keep it short): things to preserve.
4. **Findings**, each with an ID (`<your-name>-P1-2`), size, steps from a known state, expected vs
   observed (quote the screen), evidence files, whether it reproduced, and a concrete fix. ASCII
   mockups are welcome. Put problems with the tools, Herdr or the brief in their own short list,
   not among the app's findings.
5. **Top changes:** up to five that would make the biggest difference. Fewer is fine.
6. **Notes on the brief and this skill.** What was unclear, missing, wasteful or wrong in your
   instructions, and what would have made your testing better. The organiser uses this to improve
   the next round.

Then reply with just the report's path.
