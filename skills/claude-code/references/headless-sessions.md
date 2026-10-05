# Headless output and sessions

`--output-format json` emits a final result. Inspect `subtype` for errors/partial completion and keep `session_id` for continuation. `--json-schema '<schema>'` places structured results in `structured_output`; allow enough turns to gather required context.

For progress, use `--output-format stream-json --verbose`. Add `--include-partial-messages` for token deltas. Output is newline-delimited JSON; store it in a task-specific log and extract relevant events. `system/api_retry` events can explain delays. Bidirectional clients use `--input-format stream-json --output-format stream-json --replay-user-messages`; this is unnecessary for ordinary one-shots.

```bash
claude -p 'Finish only the observed failing case; leave changes uncommitted.' \
  --resume "$session_id" --output-format json
```

Reapply permissions appropriate to the resumed task. `--continue` selects the most recent conversation in the current directory; prefer an explicit ID when multiple jobs exist. `--fork-session --resume "$session_id"` preserves history under a new ID. `--no-session-persistence` disables saved sessions in print mode. `--from-pr` selects a linked session, not PR source context.

For isolated work use `--worktree <name>`; `--tmux` requires a worktree. `--add-dir` expands accessible directories. Track long runs through the host's background session and captured output. Before terminating a slow run, inspect progress and filesystem changes; empty buffered output is not evidence that nothing happened.

`--fallback-model` changes the model on overload; use it only if that substitution fits the user's model preference. `--max-budget-usd` is an API spend cap. Consult installed help for supported turn limits and permission modes instead of assuming every version has the same flags.
