---
name: droid-agent
description: "Delegate implementation, planning, or code review to Factory Droid CLI when explicitly requested."
disable-model-invocation: true
---

# Droid CLI

Use `droid exec --cwd <repo>` for headless work. Check `droid exec --help` for installed models/options and `droid --version` for availability. Authenticate through Factory login or `FACTORY_API_KEY`; never print the key.

Always pass `--model`. Preserve the user's chosen set: `auto` for dynamic/cheap routing and `grok-4.5 --reasoning-effort high` for nontrivial work. Auto does not accept reasoning effort; Grok 4.5 accepts low, medium, high. If unavailable, consult help and resolve within this set unless the user requests another model.

Default exec is read-only. Tool overrides can broaden that default, so omit mutation-enabling overrides for reviews. Choose autonomy for each invocation, including continuations:

| Autonomy        | Intended capability                                                                   |
| --------------- | ------------------------------------------------------------------------------------- |
| No `--auto`     | Inspection and planning                                                               |
| `--auto low`    | Basic local file edits                                                                |
| `--auto medium` | Code edits, installs, builds/tests, local git                                         |
| `--auto high`   | Pushes, deployments, sensitive/arbitrary execution; only when intended and authorized |

```bash
cd /path/to/project
droid exec --cwd "$PWD" --model grok-4.5 --reasoning-effort high --auto medium \
  'Implement the agreed auth fix. Leave changes uncommitted. Report checks run.'
```

For review, omit `--auto`, give the actual requested base/head, and ask for grounded findings without edits or posting. Verify review claims against the code.

After implementation, inspect actual changes and reported check evidence. Reuse checks that cover the final changes and relevant environment; run missing or warranted project checks. Repeat checks when new edits, failures, or unresolved concerns justify it. On partial output inspect actual state before a narrow continuation. Stop retrying when the blocker cannot be resolved with available input. Commits, pushes, PRs, and comments require that scope in the request.

Read [sessions, tools, and worktrees](references/sessions-tools-worktrees.md) for resumption/output/isolation. This skill covers exec workflows; mission/spec orchestration requires separate task-specific guidance and is not implied by a coding request.
