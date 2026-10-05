# Sessions and host constraints

`--json` emits JSONL events; `--output-last-message <file>` saves the final answer. Track the host's background session and use task-specific logs for long runs. Preserve explicit session IDs; `codex exec resume <id> '<remaining task>'` resumes one, whereas `--last` can select a different concurrent job. Check resume help for its own supported flags and ensure the effective permissions still match the task.

Separate worktrees or clones isolate concurrent edits. Verify the requested base before creating one and inspect the actual resulting directory. Cleanup only task-owned temporary resources after their changes are safely retained.

Nested sandbox setup can fail with uid-map or loopback permission errors. Diagnose that actual failure before changing permissions. `--sandbox danger-full-access` disables the Codex shell sandbox; it is not a read-only workaround. Use it only for already-authorized work inside an adequate external sandbox when the host permits it. A narrow prompt, clean git status, or later diff review does not replace isolation. If strict read-only execution cannot be provided, report the limitation rather than quietly broadening access.

`--dangerously-bypass-approvals-and-sandbox` bypasses both controls. Do not introduce it into ordinary implementation or review recipes. Non-zero exits and empty transcripts can leave partial changes; inspect the filesystem before rerunning.
