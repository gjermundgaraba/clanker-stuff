---
description: Manage dependent branches and pull requests with gh-stack, including synchronization and recovery.
license: MIT
name: gh-stack
metadata:
  upstream-source: "https://github.com/github/gh-stack"
  upstream-path: "skills/gh-stack/"
  upstream-revision: "d4ab7ab47e5b3e3708a27c8c42abcdf4bc321419"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "reconciled"
  upstream-release: "v0.2.0"
  upstream-skill-version: "0.2.0"
---

# gh-stack

A stack is linear: the bottom branch depends on trunk; each higher branch
builds on the one below. Keep changes in their owning layer, then rebase its
consumers. Read current state with `gh stack view --json` and inspect relevant
`gh stack <command> --help` before unfamiliar operations. Use the installed CLI
as the syntax authority (`gh stack help <command>` only prints top-level help).
Git 2.36+ and an authenticated GitHub CLI are required.

## Noninteractive contract

- Supply explicit branch/PR/stack arguments to `init`, `add`, and `checkout`.
  Use `submit --auto` and `view --json`; their bare forms prompt or launch a TUI.
  Never launch `switch` or the `modify` editor; both are interactive-only.
  Recovery-only `modify --continue` and `--abort` are covered in the recovery reference.
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

Local stacks share a common-directory catalog across linked worktrees. Use
navigation or explicit-target `checkout` with `--print-path` to locate a branch
owned elsewhere; check success before using its stdout path. Rebase/sync update
only affected clean owners, serialize mutations across the clone, and recover
paused operations in recorded owners. Do not auto-stash or create/remove
worktrees. Read the references before distributed operations.

For creation, publication, JSON fields, external branch managers, worktrees, or an
explicitly requested merge, read [operations.md](references/operations.md).
For conflicts, partial pushes, interrupted commands, divergent stacks, or
restructuring, read [recovery.md](references/recovery.md) before retrying.
