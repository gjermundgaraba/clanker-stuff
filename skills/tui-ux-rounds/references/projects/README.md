# Project notes

One file per app (`<app>.md`) holds what a round needs to know about it. Read the matching file before a round, write one before the first round on a new app, and update it when a round ends.

These notes describe private machines and workflows, so they are gitignored: only this README is tracked. Never put secrets in them.

Use these sections, and leave a section out only when it truly doesn't apply:

- **Run.** Installed binary and version, or the build command and its output; how to launch it; the ready text and the loading markers or first-run dialogs to wait out; the project's checks.
- **Sandbox.** The seed (an archive, or a script that builds a fresh copy) and how to make one copy per tester; how to point the app's state and config into a copy; background actions to switch off; what still leaks outside it (global stores, credentials, the network).
- **Safety.** Destructive and costly keys per mode, settings that start costly actions on their own, and the rules to paste into the brief.
- **Layout.** Breakpoints in columns and what changes at each, measured with `pane.py size`.
- **States.** How to produce empty, error, long-list and other hard-to-reach states.
- **Decided.** Each design question the user answered, with the answer and the round.
- **Open.** Known issues and undecided questions, worded as symptoms, for the brief's "already known" list.
- **Last round.** Its number, the commit or build tested, and where its reports are.
