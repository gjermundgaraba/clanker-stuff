---
name: opencode
description: "Delegate implementation or PR review to OpenCode CLI."
disable-model-invocation: true
---

# OpenCode CLI

Use `opencode run` for bounded headless tasks; no PTY is needed. Check `opencode --version`, `opencode run --help`, and `opencode auth list` when readiness is uncertain.

Login, non-login, and background shells can resolve different binaries. If behavior differs, inspect `which -a opencode` and pin the verified absolute path (often `~/.opencode/bin/opencode`).

```bash
cd /path/to/project
opencode run 'Implement the agreed fix and run relevant checks. Leave changes uncommitted.'
```

`--model provider/model` selects a model; `--variant` is provider-specific reasoning effort, and `--thinking` shows thinking blocks. Preserve the user's selection. `--agent plan` chooses planning instead of build behavior, but does not by itself establish OS-level read-only isolation. Scope permissions and workspace access to the task; a prompt alone is not enforcement.

After implementation, inspect actual changed/untracked files and reported check evidence. Reuse checks that cover the final changes and relevant environment; run missing or warranted project checks. Repeat checks when new edits, failures, or unresolved concerns justify it. For a partial run, inspect state and resume with the concrete remaining blocker rather than blindly repeating the task. Commit/push/PR creation and posting findings are conditional on the requested outcome.

Read [PR review](references/pr-review.md) to fetch the requested PR and its actual base with complete context. `opencode pr <number>` fetches/checks out the PR and launches OpenCode; it is not a headless review command.

For continuation, `--session <id>` selects an exact session and `--continue` selects the last; `--fork` forks either selection. `--format json` emits raw JSON events, not a single final result. `--file <path>` attaches context files; quote each path. `--attach <url>` connects to a running server, and `--dir` then refers to a server-side directory. Use separate worktrees for concurrent edits and capture long runs with a tracked session/log.
