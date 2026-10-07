# Recovery and restructuring

Read stderr and inspect Git/stack state before retrying. A failed operation can
have changed local or remote state; preserve any user's unrelated changes.

## Rebase conflicts

`sync` conflicts normally restore all branches to their pre-rebase state and
return 3; after successful restoration there is no active sync rebase to
continue. Rollback does not undo prior fetches or completed fast-forwards.
Partial restoration failures retain recovery state: inspect diagnostics and
the journal before starting another operation.

After a restored sync, start `gh stack rebase` to expose conflicts. Resolve
and stage files in the worktree path reported by the diagnostic, not
automatically in the caller's tree. Then run `gh stack rebase --continue`;
repeat for subsequent conflicts, which may belong to different owners.
`--continue` and `--abort` may run from any linked worktree and use the
recorded owners. If resolution cannot be completed, `--abort` restores
pre-rebase branches; inspect any restoration failure rather than assuming
recovery completed.

## Shared catalogs and locks

Legacy worktree catalogs migrate automatically only when definitions agree
or are disjoint, preserving originals. On conflicts, reconcile the reported
source definitions rather than choosing the newest file. Finish legacy
operations in their original worktree first; do not mix old and new gh-stack
writers in one clone.

Exit 8 can mean the short catalog lock (`<common-dir>/gh-stack.lock`) or the
clone-wide mutation lock (`<common-dir>/gh-stack-operation.lock`). Wait for
the other writer and retry; read-only views remain available. Do not delete
locks to bypass coordination. Paused operations remain protected by shared
recovery journals after their process locks are released.

For separate-git-dir repositories, main invocation and existing absolute or
relative `core.worktree` backlinks are supported, including main
`config.worktree` settings. Linked invocation without a main-worktree
backlink can leave a required main owner unresolved. Follow the diagnostic:
run from the main worktree or supply the backlink only when authorized to
change config. Never guess its checkout or navigate to an administration
directory. Unaffected worktrees can continue.

## Interrupted distributed modify

Never launch the TUI-only `gh stack modify` editor. If someone else left an
interrupted operation, inspect the pending work and requested outcome before
using recovery-only `modify --abort` or `modify --continue`. Recovery
flags may run from any linked worktree and operate in recorded native
operation owners. Resolve and stage only at the reported conflict path;
the next conflict may be in another owner.

Distributed modify runs renames, fold-down cherry-picks, and rebases in
affected clean owners; unoccupied branches use the origin. Drop/fold source
branches and their worktrees remain intact. Abort reverses owner-local
renames, restores only touched refs, and deletes only proven
operation-created refs, never worktrees. Missing owners, externally changed
refs, or save failures retain the journal; do not discard it to force progress.

`submit` also detects pending modify state and may prompt under a TTY before
overwriting the matching GitHub stack with local state. Resolve the pending
operation first; an unrelated stack cannot consume or clear its journal.

## Partial publication

`push` and `submit` are not atomic. If a lease rejects one branch, other branches
and earlier PR updates may already have landed. Inspect the rejected branch and
remote head, reconcile the conflicting work, then rerun the same command.
Do not bypass lease checks with an unconditional force push. Confirm resulting
heads and PR state afterward. `sync`'s branch push is atomic, but the whole
fetch/rebase/API workflow is not a transaction.

## Divergence and restructuring

A noninteractive `Sync aborted` can return 0 without synchronization. Compare
local and GitHub chains to determine the intended dependency order. When
rebuilding is in scope, record the original order and refs before unstacking.

`unstack` removes local tracking and the GitHub grouping, retaining PRs.
`unstack --local` only removes local tracking. `unstack <number>` operates on
GitHub from anywhere in the repository; it is not a harmless local reset.
An untracked number with `--local` is an error. Recreate the desired chain with
`init <ordered-branches>` and publish only if authorized. For a checkout
tracking conflict, local-only unstacking followed by checkout can recover it
without deleting the remote grouping. Do not delete branches as an automatic
part of rebuilding a stack.

Changing stack metadata does not change Git ancestry. For a reorder, record
old boundary SHAs and inspect each layer's range with
`git log <old-parent>..<branch>` before moving refs. Replay the intended ranges
bottom-to-top, then rebuild tracking; do not assume `init` reorders commits.
Remote unstacking leaves queued or auto-merging PRs stacked. If that blocks
recovery, inspect and clear that state only when authorized.

## Exit codes

| Code | Meaning / next action                                               |
| ---- | ------------------------------------------------------------------- |
| 0    | Command ended normally; inspect status, especially `Sync aborted`   |
| 1    | Generic error; inspect stderr and partial progress                  |
| 2    | Missing stack or remote stack not found; inspect the target         |
| 3    | Rebase conflict; inspect restoration and the recorded owner         |
| 4    | GitHub API failure; diagnose auth/service state before retry        |
| 5    | Invalid arguments or adding below the top; correct target/arguments |
| 6    | Shared branch ambiguity; check out a non-shared branch              |
| 7    | Rebase already in progress; inspect, then continue or abort         |
| 8    | Catalog/mutation lock; wait for the other writer, then retry        |
| 9    | Stacked PRs unavailable; report repository capability limit         |
| 10   | Interrupted modify; inspect pending work before `modify --abort`    |
