---
name: pi-agent
description: "Delegate implementation, planning, or constrained code review to Pi coding agent CLI."
disable-model-invocation: true
---

# Pi coding agent CLI

Use `pi -p` from the intended repo for one-shot work. Check `pi --help` for installed flags and `pi --list-models <search>` for provider availability. MCP controls below follow Pi 1.0.4; older installations may differ. If PATH differs in a non-login shell, resolve the intended binary through the user's Node setup; do not substitute a different installation silently.

Always pass `--model`, preserving these preferences unless the user chooses otherwise:

| Workload                             | Model                   |
| ------------------------------------ | ----------------------- |
| General coding                       | `fugu-proxy/fugu`       |
| Hard implementation, design, reviews | `fugu-proxy/fugu-ultra` |
| Large-context alternative            | `opencode-go/kimi-k3`   |
| Review/planning alternative          | `xai/grok-4.5`          |

Prefer `--thinking high` for nontrivial work. Supported levels are off, minimal, low, medium, high, xhigh, max; model support varies. Resolve unavailable models using the catalog and preserve explicit user choices.

Pi has no permission popups or `--force`. Default tools include writes and shell execution. A read-only prompt cannot prevent writes; use an inspection-only allowlist:

```bash
cd /path/to/project
pi -p --no-approve --no-extensions --no-skills --tools read,grep,find,ls \
  --model fugu-proxy/fugu-ultra --thinking high \
  'Review this repository and summarize its test strategy. Do not edit files.'
```

Keep `--no-extensions` in strict reviews: `--tools` alone can retain indirect MCP access. When retaining other extensions, `--no-mcp` disables built-in MCP startup for one invocation, not replacement MCP extensions or other extension startup behavior.

For a precomputed diff, use `--no-tools` with stdin (and `--no-extensions` to avoid extension startup behavior). `--exclude-tools edit,write` still leaves shell tools capable of writes and is not strict read-only. Trust and tool controls are separate: `--approve` trusts project-local resources; `--no-approve` ignores them. Noninteractive runs show no trust prompt.

```bash
pi -p --approve --model fugu-proxy/fugu-ultra --thinking high \
  'Implement the agreed auth fix. Leave changes uncommitted. Report checks run.'
```

After implementation, inspect changed/untracked files and reported check evidence. Reuse checks that cover the final changes and relevant environment; run missing or warranted project checks. Repeat checks when new edits, failures, or unresolved concerns justify it. Validate review claims against the actual code. Interrupted runs may leave edits; resume narrowly from observed state and stop if further progress requires unavailable input. Commit, push, PR creation, and posting require the corresponding requested outcome.

Read [context and trust](references/context-trust.md) for attachments and strict reviews; [sessions, streams, and background runs](references/sessions-streams.md) for continuation or integrations.
