---
name: tui-ux-rounds
description: Run a round of UX testing on a terminal UI inside Herdr — review it yourself, brief Claude Code and Codex tester agents in their own tabs, then triage, fix what is authorised, verify and report. Use when asked for a UX or user-testing round with tester agents in Herdr, or to continue such rounds.
---

# TUI UX rounds

A round ends with the user holding a short report: what changed, what testers found, what was fixed and verified, and the decisions that are theirs. You also maintain this skill and [the tester skill](../tui-ux-tester/SKILL.md), which must be installed next to it: its `scripts/` drive and capture panes for you as well.

Requires Herdr (`HERDR_ENV=1`); the `herdr` skill has CLI details. Invoking this skill authorises the tabs, run directory and report files described here, which the `herdr` skill would otherwise not create unasked. It doesn't authorise closing tabs you didn't create.

## Before the round

- **Mode.** Fix rounds fix what the user authorised; report-only rounds stop after triage and list each fix as proposed, with the test you would add. Ask only if the request doesn't say.
- **Project note.** Read the app's note in [references/projects/](references/projects/). No note yet? Write one first, following that folder's README: how to run it, where it keeps state, what it does in the background, which keys are destructive or costly, its layout breakpoints, a ready text, and how to produce empty and error states.
- **Run directory** `/tmp/<app>-review-<n>/` holds briefs, reports, evidence and your notes. It is scratch: anything later rounds need goes in the project note.
- **Sandboxes.** Destructive or writing actions only ever happen in a throwaway copy. Give each tester its own, made fresh from a seed (an archive or a script the project note names), so their changes can't mix. Reset a sandbox by deleting it and recreating it from the seed, and only once nothing runs in it. Point the app's own state and config into the sandbox where the app allows it, and switch off background network actions (auto-fetch, update checks). A copied directory doesn't isolate global state, credentials or the network; the project note says what still leaks. A seed saved from a used copy carries its state, including paths into that copy: empty it first.
- **App tab.** Build, then run the app in its own tab (`herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label <app>-ui --no-focus --cwd <sandbox>`; reuse one left from an earlier round). Launch it as `<cmd>; echo EXIT=$?` (fish: `$status`) so an unexpected exit leaves a trace, and relaunch after every build.

## Look at it

Use the tester skill's scripts (resolve its folder with `readlink -f`):

- `pane.py size <pane> <cols> <rows>` sets an exact terminal size (the pane must be the first in its tab; `full` restores it). Sizes are what the app gets, measured with `stty`; `herdr pane layout` rectangles include borders and ignore zoom.
- `pane.py capture <pane> <dir> <label>` saves a settled frame as ANSI, text and a style summary; `pane.py shot <pane> <out.png>` also renders it, and you read the PNG to look at it. Plain text hides backgrounds and dimming, so judge those only from the summary or a PNG. Palette colours (`cN`) come from the user's theme, so contrast between them can't be judged from a capture.
- Drive it with `herdr pane send-keys` as the tester skill describes (quote keys; space is `space`).
- Check wide (a whole tab), one column either side of each breakpoint in the project note, and 79×24. In a sizing loop, stop when `pane.py size` fails: the pane keeps its old size, and captures labelled with the size you asked for would lie. Your shell may not be bash (fish rejects `set --`); run loops with `bash -c`.

## A round

1. **Review it yourself** (about 15 minutes). Cover what changed since the last round at each size, plus loading, a long list, many selected, popups and each tab; empty and error states when the project note says how to produce them. Prefer states with several rows over one. Do destructive checks last, or reseed after them, and detect layouts by their structure (borders, box positions), not by content a check may have removed. Write it to `orchestrator.md` in the run directory in the tester report format, so triage compares three reports.
2. **Brief the testers.** Fill in [the brief template](references/brief-template.md), with the probes in a file of their own. Measure every number you quote, including ones from the project note (older ones may be pane rectangles), and try every key or behaviour you describe, including how to reach the state it needs, in each layout testers will use; if it differs by layout, say so. Check settings that make the app start costly actions on its own, and state their values. Then launch both testers as [references/lifecycle.md](references/lifecycle.md) describes and wait for their reports. **Freeze the build while they test:** they run the built app, so fix in source and tests, and rebuild only after both reports are in.
3. **Triage.** First audit safety: compare each sandbox with its seed and the reports' action ledgers against what was allowed, and put any mismatch at the top of the report. Then read both reports in full and check each claim against the code or the screen before acting on it. Testers misattribute causes, and they catch wrong claims of yours: treat those first. Sort findings into bugs, clear fixes, and real design decisions. Independent reproduction raises confidence, not priority; a shared brief, sandbox or capture bug can explain agreement. Priority comes from impact, reach and how hard recovery is. **Decide what you can.** When the owner's goal plus the evidence point to one option, pick it, do it, and say why in the report. Ask only when the options trade off things the owner values differently (cost, scope, a product direction) or the change is hard to undo. Don't send an "options A/B/C" menu when you would recommend A anyway.
4. **Fix** what is authorised, with tests that protect a real contract (screen checks cover purely visual details). Run the project's checks, rebuild, relaunch, and verify each fix on screen at the sizes it affects.
5. **Report.** Lead with the outcome. Then: a line of numbers (tester minutes, findings per tester, verified / rejected / duplicate, found by both, your claims they corrected, costly actions used of those allowed); what was fixed and verified, and how; what the testers found; the decisions the user needs to make; what wasn't done or verified; skill edits, separately from app changes. Report failures plainly, with secrets redacted.
6. **Close out.** Quit the apps, close every tab you created, copy anything costly the next round can reuse (paid results) out of the sandboxes as a seed, delete or reset them, and update the project note: the commit or build tested (`git rev-parse HEAD`, plus `git diff --stat` if dirty), what was fixed, each decision with the user's answer, and what is open.

If an advisor tool is available, consult it after your own review and before reporting. Commit only when asked, following the user's and project's commit rules. If signing or a hook blocks a commit, don't bypass it: save the messages to files and give the user the exact commands.

## When something goes wrong

- Read which assertion or `wait` failed before theorising about the cause.
- Instrument with a temporary log in the handler or state subscription, and delete it after.
- To tell a Herdr rendering artifact from an app bug, render the same state in tmux (`tmux -L x new-session -d -x <cols> -y <rows> '<cmd>'`, `send-keys`, `capture-pane -e -p`) and compare the two with `ansi.py summary`.
- A cosmetic bug you can't reproduce in isolation within a short time box goes in the report as known. Don't sink the round into it.
- Framework quirks: [references/opentui.md](references/opentui.md) for OpenTUI/Solid. Add a `references/<framework>.md` when another framework teaches you something.

## Keep these skills sharp

Note a lesson when something would have gone better had the skills said it: a trap, a step you had to rediscover, the user's feedback on how you ran the round, or a tester's notes on the brief. Collect lessons during the round and apply them at its end, as [references/maintaining.md](references/maintaining.md) describes, so testers never run on instructions that changed under them.
