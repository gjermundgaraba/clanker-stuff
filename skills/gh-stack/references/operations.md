# Stack operations

## Create and navigate

`gh stack init --base <trunk> branch-a branch-b` creates or adopts branches in
bottom-to-top order and checks out the last branch. Names are literal. If the
last existing branch is owned by another worktree, adoption succeeds without
changing the invoking checkout; inspect the reported owner. `add <branch>` adds only at the top;
use `top` first when needed. Prefer deliberate Git staging over `add -Am`.
`checkout <branch>` navigates local tracking; a PR number/URL or stack number
can fetch a remote stack. If checkout conflicts with existing local stack
tracking, inspect both structures before any `unstack --local` recovery.
A bare checkout number resolves as a stack number, then a PR number, then a
branch name. Branch-name checkout uses local tracking only.

Plan layers before writing new multi-part work. Each branch should hold one
reviewable concern with its dependencies in the same or lower layers. Follow
repository/user naming conventions; otherwise a shared topic prefix and concern
makes related branches recognizable. Put unrelated work in separate stacks.
Before editing an existing stack, identify and check out the owning layer;
use `view --json` and, when unclear, `git log --all -- <path>`. After a
committed lower-layer edit, rebase upstack before returning to consumers.

Without `-Am`, `add` carries uncommitted changes onto the new branch; commit or
stash manually when a clean start is needed. Existing foreign-owned branches
can be adopted without checkout, but staging/commit shortcuts are rejected
before changing membership or staging another owner's files.

## Worktree navigation and mutation

Linked worktrees share `<common-dir>/gh-stack`; they do not need API-only
`link`. Navigation never steals another worktree's checkout. All five
navigation commands (`up`, `down`, `top`, `bottom`, `trunk`) and
explicit-target `checkout` accept `--print-path`. A foreign-owned target
returns its owner's path without switching; an unoccupied target is checked
out here first. Without path mode, a foreign-owned target is a nonzero error.

Successful path-mode stdout contains only an absolute raw path and newline;
diagnostics go to stderr and errors leave stdout empty. Check exit status and
nonempty output before changing directories, quote the path, and never
`eval` it. Do not treat status text as a path.

`up` and `down` accept a count, clamp at stack bounds, and skip merged
branches when navigating from an active branch; `bottom` selects the lowest
unmerged branch.

`rebase` and `sync` update affected clean owning worktrees automatically.
Unoccupied branches use the operation's origin worktree. Dirty, busy, or
unavailable owners stop unsafe updates; there is no auto-stash or automatic
worktree creation/removal. Pruning skips branches occupied elsewhere.
Mutations serialize across the clone; paused operations remain guarded by
shared recovery journals. See [recovery.md](recovery.md) for locks and owners.

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
branches with each other without fetching/rebasing trunk. A cascade is needed
not only when trunk moves, but also when a stack branch fast-forwards from its
remote or no longer contains its expected parent. Squash-merged PRs are
handled using onto-rebase semantics. Conflicts during `sync` trigger cascade
rollback; see recovery for partial restoration failures and owner-local resolution.

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
The saved `base` may be older than the parent's current tip. `needsRebase`
means the current parent tip is not an ancestor. PR states include `OPEN`,
`MERGED`, and `QUEUED`. Never parse status emoji as structured state.
