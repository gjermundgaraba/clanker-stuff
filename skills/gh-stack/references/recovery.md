# Recovery and restructuring

Read stderr and inspect Git/stack state before retrying. A failed operation can
have changed local or remote state; preserve any user's unrelated changes.

## Rebase conflicts

`sync` conflicts restore all branches to their pre-rebase state and return 3;
there is no active sync rebase to continue. Start `gh stack rebase` to expose
conflicts, resolve the actual conflicted files, stage those files, then run
`gh stack rebase --continue`. Repeat for subsequent conflicts. If resolution
cannot be completed, `gh stack rebase --abort` restores pre-rebase branches.

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

## Exit codes

| Code | Meaning / next action                                                 |
| ---- | --------------------------------------------------------------------- |
| 0    | Command ended normally; inspect status, especially `Sync aborted`     |
| 1    | Generic error; inspect stderr and partial progress                    |
| 2    | Missing stack or remote stack not found; inspect the target           |
| 3    | Rebase conflict; distinguish restored sync from active rebase above   |
| 4    | GitHub API failure; diagnose auth/service state before retry          |
| 5    | Invalid arguments or adding below the top; correct target/arguments   |
| 6    | Shared branch ambiguity; check out a non-shared branch                |
| 7    | Rebase already in progress; inspect, then continue or abort           |
| 8    | Stack lock; allow the other writer to finish, then retry (5s timeout) |
| 9    | Stacked PRs unavailable; report repository capability limit           |
| 10   | Interrupted modify; inspect pending work before `modify --abort`      |
