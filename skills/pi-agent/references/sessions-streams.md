# Sessions, streams, and background runs

Sessions are normally saved under `~/.pi/agent/sessions/`, grouped by working directory. `--session <path-or-id>` selects one; `--fork <path-or-id>` copies history into a new session. `--continue` chooses the previous session, so prefer explicit IDs with concurrent work. `--name` sets a display name; `--no-session` disables persistence.

```bash
pi -p --approve --session "$session_id" --model fugu-proxy/fugu-ultra --thinking high \
  'Fix only the observed blocker: <exact command/output>. Leave changes uncommitted.'
```

Reapply inspection-only tools for a resumed review. Prefer a fresh prompt with observed state when previous assumptions are stale.

`--mode json` emits events for one-shot capture. Save to a task-specific NDJSON file; `jq -c 'select(.type == "message_end")' <log>` extracts completed messages. Avoid loading an entire verbose stream into the parent context.

Use `--mode rpc` only for a persistent client integration. Input/output use strict LF-delimited JSONL: frame and split records on `\n` only, not other Unicode line separators. Implement request/event handling against the installed protocol documentation; JSON event capture alone does not require RPC.

Pi has no special background shell abstraction or built-in worktree flag. Use ordinary git worktrees/separate clones for isolation and the host's tracked background session or a named tmux session for long runs. Keep a log and process/session ID; inspect partial filesystem changes on interruption. Remove only task-owned resources after retaining their work.
