---
name: claude-code
description: "Delegate implementation, planning, or code review to Claude Code CLI."
disable-model-invocation: true
---

# Claude Code CLI

Use `claude -p` for bounded headless work, from the intended repository. It needs no PTY. Check `claude --help` for installed-version options and `claude auth status` for readiness; missing API keys do not rule out subscription OAuth.

Print mode skips the workspace trust dialog. Calls needing interactive permission are denied; grant only the tools required by the authorized task. `--tools` limits the built-in tool set; `--allowedTools` preauthorizes calls. Configured MCP tools and hooks are separate surfaces, so a built-in tool limit is not an OS sandbox.

```bash
cd /path/to/project
claude -p 'Implement the agreed auth fix. Leave changes uncommitted. Report changed files and checks run.' \
  --allowedTools 'Read,Grep,Glob,Edit,Write' --output-format json
```

Authorize the specific project check commands too when execution is needed. Pass the user's requested model/effort; choose a finite turn or spend budget appropriate to the task when supported by the installed version.

After implementation, inspect changed and untracked files and the reported check evidence. Run missing or warranted project checks; repeat checks when new edits, failures, or unresolved concerns justify it. A timeout, max-turn error, or empty stdout can leave edits behind. Inspect actual state before resuming with the observed blocker and remaining work; stop retrying if the same blocker cannot be resolved with available input. Commit, push, open PRs, or post findings only when those actions are in the requested outcome. A review request alone produces findings.

When applying review findings, translate each accepted finding into the behavior or invariant to preserve, with relevant code evidence. Preserve the project's compatibility requirements; findings do not authorize a greenfield rewrite. Delegate only the accepted implementation scope.

Read only the relevant detail:

- [Headless output and sessions](references/headless-sessions.md) for JSON, streaming, resumption, and isolation.
- [PR review](references/pr-review.md) for the actual requested head/base; `--from-pr` resumes a linked conversation and does not perform a PR review.
- [Multi-agent review](references/read-only-multi-agent-review.md) when the user requests multiple reviewers before changes.
