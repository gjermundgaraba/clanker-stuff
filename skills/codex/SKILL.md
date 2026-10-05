---
name: codex
description: "Delegate implementation or code review to OpenAI Codex CLI."
disable-model-invocation: true
---

# Codex CLI

Use `codex exec` for noninteractive tasks with an explicit working directory. A git repo is the default trust/check boundary; use `--skip-git-repo-check` only for intentional non-repository work. OAuth can be configured without `OPENAI_API_KEY`; use `codex login status` instead of reading credentials.

```bash
codex exec -C /path/to/project --sandbox workspace-write \
  'Implement the agreed fix. Leave changes uncommitted and report checks run.'
```

Choose permissions within host authorization. Installed CLI versions differ: check `codex exec --help`; do not assume historical `--full-auto` is available. `exec` needs no interactive UI; use a PTY only if the host runner requires it.

For report-only review, set the read-only shell sandbox and supply the actual base and requested scope:

```bash
codex exec -C /path/to/project --sandbox read-only \
  'Review git diff <verified-base>...HEAD. Report grounded correctness findings with file/line evidence. Do not edit files or post comments.'
```

The shell sandbox does not itself restrict external connectors. Keep connected tools and the prompt within report-only scope. Capture staged, unstaged, and untracked files when those are part of the requested review; a PR comparison alone does not include them.

After implementation, inspect actual changes and reported check evidence. Reuse checks that cover the final changes and relevant environment; run missing or warranted project checks before reporting success. Repeat checks when new edits, failures, or unresolved concerns justify it. On interruption inspect partial work, then resume narrowly or finish directly. Commit, push, create PRs, and post review comments only when requested; they are not automatic completion steps.

Read [sessions and host constraints](references/sessions-host.md) for long runs, resumption, and sandbox failures. Read [PR context](references/pr-review.md) for an isolated requested-PR checkout.
