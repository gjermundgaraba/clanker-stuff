# Maintaining these skills

Read this at the end of a round, before applying skill edits.

## During the round: collect

Append each lesson to `skill-notes.md` in the run directory: the file it belongs in, the old and new text, why, and the evidence (what happened, or which tester note). Don't edit the skills mid-round: testers already running would follow instructions that changed under them. A safety problem is the exception: stop or re-brief the affected testers, then fix it.

## At the end: apply

- **Check you may.** Running rounds includes keeping these skills up to date. Skip applying, and put the notes in the report as proposals, when the round is report-only, the user said not to edit skills, or another round on these skills is still running (one writer at a time).
- **Re-read the current files first**; someone may have changed them since the round began.
- **Route each lesson.** Would it hold for a different app in a different framework? Then it belongs in a SKILL.md or the brief template. True for one framework: `references/<framework>.md`. Otherwise: the project note. A lesson that is a procedure (sizing, waiting, resetting) belongs in a script with a test, not in more prose.
- **Keep it small.** A rule plus the reason, not a story. Merge or delete guidance that proved wrong instead of adding exceptions. Keep each SKILL.md near its current length: if an edit pushes it much past ~120 lines, cut or merge something.
- **Verify a cause before promoting it to a rule.** A tester's explanation is a hypothesis until you have checked it.

## Public and private

The skill folders are tracked in a public repository (resolve the installed symlinks with `readlink -f` to find it); project notes are gitignored. In tracked files:

- Examples must be invented or generic, never quotes, names or numbers from a real project.
- No secrets, private paths, user names, hostnames or machine details.
- Before finishing, grep the tracked diff for them, and for the name of every project that has a note: `git diff -- <skill folders> | grep -inE '/Users/|/home/|<project names>'`.
- Run the repository's checks when you changed a script (its Python tests cover the scripts here).

List the edits in the round report, separately from app changes, and commit them only when the user asks.
