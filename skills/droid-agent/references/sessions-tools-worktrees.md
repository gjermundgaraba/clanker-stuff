# Sessions, tools, and worktrees

Choose autonomy for each continuation from the remaining task and existing authorization, using the table in `SKILL.md`. Basic local edits can use `--auto low`; the example below uses `--auto medium` because it includes edits and validation:

```bash
droid exec --cwd "$PWD" --session-id "$session_id" --auto medium \
  --model grok-4.5 --reasoning-effort high \
  'Fix only this observed blocker and run the relevant check: <exact command/output>. Leave changes uncommitted.'
```

`--fork "$session_id"` creates a new local session from the history; choose autonomy for the fork by the same rule. For review or planning continuations and forks, omit autonomy flags and mutation-enabling tool overrides. Both session operations require a prompt, load history, and do not replay old messages into output.

`--file <path>` loads a prompt file; `--output-format json` captures structured output. Use a task-specific output file for long responses. For stream JSON-RPC integrations, session settings come from requests: CLI model/autonomy/reasoning flags are validated but do not configure those sessions.

`--worktree <name>` selects a branch to use or create; `--worktree-dir <path>` chooses its directory. Verify the intended starting branch and inspect the actual resulting worktree. Use separate workdirs for concurrent edits. Track long runs via host background handles or named tmux sessions with logs; retain work before cleaning task-owned resources.

`--list-tools` lists tools. `--enabled-tools` restricts the set, `--additional-tools` adds to defaults, and `--disabled-tools` removes tools. Explicitly enabling a mutation tool can broaden the default read-only behavior; do not use those overrides to bypass review restrictions.

`--skip-permissions-unsafe` bypasses checks and cannot be combined with `--auto`. It is for intentionally isolated environments, not a routine fix for a denied command.
