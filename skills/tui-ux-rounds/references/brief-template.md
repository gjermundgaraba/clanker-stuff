# Brief template

Copy to `/tmp/<app>-review-<n>/brief.md`, replace every `<…>`, and delete what doesn't apply. Put the "Then probe these" section in `probes.md` next to it: agents read a whole file at once, so a separate file is the only way to keep the probes from steering the new-user pass. Copy the safety rules from the project note and adapt them only to this round's targets: testers follow them literally, so leave no generic example in place. Before launching, search the brief for leftover placeholders.

---

# Brief: user-test `<app>` (round <n>, <report only | fixes follow>)

First read `<resolved folder of tui-ux-tester>/SKILL.md` as a file: it explains how to drive the app, what to look at and the report format, and its scripts are in that folder's `scripts/`. This brief supplies the specifics and wins over the skill where they differ, but never over a safety rule.

| Tester | Agent | Agent pane | App pane (its own tab) | Sandbox | Target for writes |
| --- | --- | --- | --- | --- | --- |
| <name-a> | Claude Code | <pane> | <pane> | <dir> | <target-a> |
| <name-b> | Codex | <pane> | <pane> | <dir> | <target-b> |

Spend about <minutes: 10 for the new-user task plus about 4 per probe; add them up> minutes testing, then write what you have.

## The app

<One paragraph: what it does, who it's for, and what the owner wants from it.>

- Build under test: `<built file>`, modified <time> (source may move on; findings are against this build).
- Run in your app pane (its shell is <shell>): `<command>; echo EXIT=<$? or $status>`. Help: `<command> --help`. Source, read-only: `<path, or "not available">`.
- Ready when the screen shows `<text only the loaded app draws>` and none of `<every busy marker the app shows while loading, such as "loading" and "checking", or a first-run dialog>`. Name them all: waiting for one to go can return while another is still on screen. <How to dismiss a first-run dialog, if any.> (Check the ready text at 79 columns: footers and titles drop text first.)
- Areas to cover: <modes, tabs, popups>.
- Sizes: the whole app tab, <breakpoints ±1 column, from the project note>, and 79×24.
- What exists to look at: only what safety needs before the new-user task (which items are safe to change). Put fixtures that would answer the new-user task (a clean result, the one removable item) in `probes.md`, or the first pass is guided rather than blind.

## Safety rules

| Action | Allowed | Limit |
| --- | --- | --- |
| <destructive key or flow> | NEVER in <mode or place>; it would change this real machine | none |
| <write, such as an update> | only in your sandbox, on your target | ONE |
| <costly action, such as a paid call> | only in your sandbox | at most ONE |

Limits count confirmed actions, not key presses: a key the app rejects doesn't count, and a retry counts as another action. When one allowance has to cover the new-user task and probes, say how to spend it (one on X, one on Y), and leave one spare for reproducing a finding.

- <Settings that make the app start costly actions on its own, their current values, and how
  they multiply (for example one per selected item). Don't change them.>
- Confirm a destructive action only when the selection is exactly your target.
- <Keys that reach outside the sandbox (other repos or projects, a browser, a shell, an editor),
  per panel: the same key can be harmless in one panel and leave the sandbox in another.>
- Look at settings, but don't add or change credentials or sign in to anything.
- Don't edit files under `<repo>` or run git there.
- Don't copy secrets, tokens, emails or hostnames from the screen into your report.

## First, as a new user

<A goal in the user's terms, such as "find out which items need attention and deal with one
safely". Make sure it doesn't destroy what the probes need, or say how to recreate it.> Note where you hesitated or guessed. When you're done, read `probes.md` next to this brief.

## Deliverable

Write `/tmp/<app>-review-<n>/<your-name>.md` in the skill's report format, with evidence under `/tmp/<app>-review-<n>/<your-name>/`, then reply with just the path. Don't read the other tester's report or earlier rounds' reports.

---

`probes.md` (the two sections below; the deliverable stays in the brief):

## Then probe these (changed since the last round)

- <feature>: what to try and what working looks like to a user. Give numbers as measured on this build and say how; say where a result appears when that isn't obvious; say when a key behaves differently in another layout, and whether a state is what shows right after an action or only after a restart. Name a lazy behaviour and where it shows first (a mark that appears only after a tab is opened: say which package and tab), and ask for a quit and relaunch wherever something should be remembered. Name terms precisely ("checked rows" or "the cursor", not "selection").
- Report anything unexpected: the app exiting on its own, keys that stop responding, layout glitches.

## Already known (mention only if you see something new)

- <open item from the project note, worded as the symptom a user sees, not as the fix>
