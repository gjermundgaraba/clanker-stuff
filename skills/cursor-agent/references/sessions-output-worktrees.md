# Sessions, output, and worktrees

Set `cursor_bin` in the current shell to the absolute Cursor executable path verified through `SKILL.md` before running these examples.

Prefer `--output-format json` for orchestrated results; parse `result` and inspect errors. Text output has sometimes been empty on long successful runs, so do not equate empty stdout with no changes. `--output-format stream-json --stream-partial-output` emits NDJSON and incremental deltas; keep a task-specific log and summarize events.

Use `--resume <chat-id>` for exact continuation. `--continue` chooses a previous session and can be ambiguous with concurrent work. `ls` lists/resumes chats; `create-chat` prints a new chat ID.

```bash
"$cursor_bin" -p --trust --force --resume "$chat_id" \
  --model 'grok-4.5[effort=high,fast=true]' --output-format json \
  'Fix only the observed failing case described here: <command/output>. Leave changes uncommitted.'
```

Retain Ask/Plan mode for resumed reviews/planning instead of carrying over implementation force flags.

`-w <name>` creates an isolated worktree under `~/.cursor/worktrees/<repo>/<name>`. `--worktree-base <ref>` selects the base (default current HEAD); `--skip-worktree-setup` skips `.cursor/worktrees.json` setup scripts. Choose the base and whether those scripts should run before launch.

```bash
"$cursor_bin" -p --trust --force -w auth-fix --worktree-base "$base_ref" \
  --model 'grok-4.5[effort=high,fast=true]' --output-format json \
  'Implement the agreed auth fix. Leave changes uncommitted.'
```

Inspect results in the actual worktree path. Use separate worktrees for concurrent edits, track long tasks through host background sessions or a named tmux session, and clean up only resources created for the task after retaining their work.

`--sandbox enabled` enables command sandboxing; `--sandbox disabled` disables it. `--workspace <path>` selects the working root. These controls are distinct from workspace trust and `--force`; verify installed help rather than assuming one implies the others.
