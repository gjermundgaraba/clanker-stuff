# Stack operations

## Create and navigate

`gh stack init --base <trunk> branch-a branch-b` creates or adopts branches in
bottom-to-top order. Names are literal. `add <branch>` adds only at the top;
use `top` first when needed. Prefer deliberate Git staging over `add -Am`.
`checkout <branch>` navigates local tracking; a PR number/URL or stack number
can fetch a remote stack. If checkout conflicts with existing local stack
tracking, inspect both structures before any `unstack --local` recovery.

## Publish

`push` updates active (not merged or queued) branches via a non-atomic multi-ref
push with explicit per-branch force-with-lease checks. It does not create PRs.
`submit --auto` pushes branches sequentially, creates missing PRs with the first
non-merged ancestor as base, and links the GitHub stack. Earlier pushes/PR
updates survive a later failure; see [recovery.md](recovery.md).

New PRs are drafts. `--open` marks new and existing PRs ready. A one-commit
branch supplies its commit subject/body; multiple commits use a humanized branch
name. There is no custom title/body flag; edit the PR afterward when requested.
If all old stack PRs were merged, submission creates a new stack for the
unmerged branches. Exit 9 means stacked PRs are unavailable in that repository.

## Synchronize

`sync` fetches, reconciles remote stack membership locally, fast-forwards trunk
when possible, cascade-rebases if trunk moved, pushes active branches atomically,
and syncs PR and stack state. It never opens PRs. New remote stack members can
be pulled locally. Divergence may return `Sync aborted` with exit 0; check the
reported outcome. Pruning merged local branches requires `--prune` in
noninteractive use; only request it when cleanup is in scope.

`rebase --upstack` propagates the current layer through its consumers;
`--downstack` covers trunk through the current branch. `--no-trunk` only aligns
branches with each other without fetching/rebasing trunk. Squash-merged PRs are
handled using onto-rebase semantics. Conflicts during `sync` restore all
branches; use the explicit rebase recovery path afterward.

## External branch management

`gh stack link branch-a branch-b` manages remote PRs/stack grouping without
local stack tracking, useful with jj or Sapling. It pushes and creates PRs.
Supply at least two branches/PRs to create or update a stack, or the existing
stack number plus new members to append them: `gh stack link 7 branch-c`.

## Requested merges

Use `gh stack merge <target> --yes`, not `gh pr merge`, for stacked PRs.
Choose an unambiguous PR or stack target from live state. A PR target merges
through that PR; a stack target covers the stack. Specify the requested method
via `--squash`, `--rebase`, `--merge`, or `--merge-method`; otherwise the last
method is reused. Direct merging is all-or-nothing and cannot bypass merge
requirements. With a merge queue, PRs are queued together but may land in
separate groups, and the queue determines the method.

## Read state

`view --json` writes data to stdout; status goes to stderr. Top-level fields
include `trunk`, `currentBranch`, and `branches`. Branch records carry `name`,
`head`, `base` (parent HEAD at last sync), `isCurrent`, `isMerged`, `isQueued`,
`needsRebase`, and optional `pr` (`number`, `url`, `state`). `pr` may be absent.
`needsRebase` means the base is not an ancestor. PR states include `OPEN`,
`MERGED`, and `QUEUED`. Never parse status emoji as structured state.
