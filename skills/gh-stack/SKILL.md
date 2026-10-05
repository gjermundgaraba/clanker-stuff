---
description: Manage dependent branches and pull requests with gh-stack, including synchronization and recovery.
metadata:
  author: github
  github-path: skills/gh-stack
  github-ref: refs/tags/v0.1.0
  github-repo: https://github.com/github/gh-stack
  github-tree-sha: c95c8b5b4dd850f3fef007b304428f5684f2fb87
  version: 0.0.9
name: gh-stack
---

# gh-stack

A stack is linear: the bottom branch depends on trunk; each higher branch
builds on the one below. Keep changes in their owning layer, then rebase its
consumers. Read current state with `gh stack view --json` and inspect relevant
`gh stack <command> --help` before unfamiliar operations. Use the installed CLI
as the syntax authority; the metadata records this guide's upstream version.

## Noninteractive contract

- Supply explicit branch/PR/stack arguments to `init`, `add`, and `checkout`.
  Use `submit --auto` and `view --json`; their bare forms prompt or launch a TUI.
- With multiple remotes, select the intended remote via `--remote` on `push`,
  `submit`, `sync`, `rebase`, or `link`. `checkout`, `modify`, and `trunk` instead
  require the appropriate `remote.pushDefault`. Inspect existing config before
  changing it; do not assume `origin`. `init` enables git rerere; pre-enable it
  locally when needed to avoid its confirmation prompt.
- Use explicit staging with normal Git commands when committing is in scope.
  `add` is allowed only on the top branch. A branch shared by multiple stacks
  needs disambiguation by checking out a non-shared branch.
- Publishing, merging, pruning, and unstacking are separate actions; perform
  only those within the user's requested outcome. `sync` includes a push.
- Read stderr as well as the exit code. **`Sync aborted` can exit 0 and means
  synchronization did not happen.** Confirm the resulting branch/PR state.

## Choose the operation

| Outcome                                | Command shape                                               |
| -------------------------------------- | ----------------------------------------------------------- |
| Create/adopt ordered branches          | `gh stack init branch-a branch-b`                           |
| Add the next layer                     | `gh stack add branch-c`                                     |
| Navigate                               | `gh stack checkout branch-a`, `up`, `down`, `top`, `bottom` |
| Propagate a committed lower-layer edit | `gh stack rebase --upstack`                                 |
| Push branches only                     | `gh stack push`                                             |
| Push and create draft PRs              | `gh stack submit --auto`                                    |
| Fetch, rebase, push, reconcile stack   | `gh stack sync`                                             |

For creation, publication, JSON fields, external branch managers, or an
explicitly requested merge, read [operations.md](references/operations.md).
For conflicts, partial pushes, interrupted commands, divergent stacks, or
restructuring, read [recovery.md](references/recovery.md) before retrying.
