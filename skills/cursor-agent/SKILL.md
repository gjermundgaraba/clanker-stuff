---
name: cursor-agent
description: "Delegate implementation, planning, or read-only review to Cursor Agent CLI."
disable-model-invocation: true
---

# Cursor Agent CLI

Use Cursor's `agent` binary for headless tasks. Locate a candidate executable (`agent` or a local `cursor-agent` alias), set `cursor_bin` to its absolute executable path, and inspect its help:

```bash
cursor_bin="/absolute/path/to/cursor-agent"
"$cursor_bin" --help
```

Continue only when the help identifies Cursor: `agent` can resolve to another product (including Grok). Keep using that verified path, setting `cursor_bin` in each shell that runs these examples. Check `"$cursor_bin" status` for auth and summarize account metadata rather than printing it raw.

Always pass `--model`. Preserve these preferences unless the user chooses otherwise:

| Workload                                               | Model                             |
| ------------------------------------------------------ | --------------------------------- |
| Narrow mechanical work                                 | `composer-2.5`                    |
| Design, reviews, hard bugs, substantial implementation | `grok-4.5[effort=high,fast=true]` |

`"$cursor_bin" models` lists account availability. If the selected model is unavailable, resolve availability before retrying; keep the requested effort tier and do not silently replace an explicitly required model.

```bash
cd /path/to/project
"$cursor_bin" -p --trust --force --model composer-2.5 --output-format json \
  'Apply the agreed rename and update callers. Leave changes uncommitted. Report checks run.'
```

`--trust` trusts workspace resources; use it only when intended. Print mode has write/shell tools, and scripted edits need `--force` (alias `--yolo`) to apply without confirmation. This broadly allows commands unless denied; it is not a file-edit-only permission. Without it an implementation may only propose changes.

Use Ask mode for review, Plan mode for a plan:

```bash
"$cursor_bin" -p --trust --mode=ask --model 'grok-4.5[effort=high,fast=true]' --output-format json \
  'Review git diff <verified-base>...HEAD. Do not edit or post. Return grounded findings with file/line evidence.'
```

Replace the base with the requested PR's actual base; check out the requested PR in an isolated clone if the current checkout has unrelated work. `--plan` / `--mode=plan` produces a read-only plan. Prompt wording alone is not a substitute for selecting the mode.

After edits, inspect changed/untracked files and reported check evidence. Reuse checks that cover the final changes and relevant environment; run missing or warranted project checks. Repeat checks when new edits, failures, or unresolved concerns justify it. Empty text output can accompany completed or partial edits; inspect the filesystem. Resume with the observed blocker and remaining scope, stopping when an unresolved dependency needs outside input. Commit/push/PR creation or posting findings is conditional on the requested outcome.

Read [sessions, output, and worktrees](references/sessions-output-worktrees.md) only when those features are needed.
