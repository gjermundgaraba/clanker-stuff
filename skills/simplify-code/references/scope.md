# Capture the review scope

In a repository with a HEAD commit:

```bash
# Default: staged and unstaged tracked changes relative to HEAD
git diff HEAD
# Explicit scopes
git diff --staged                 # staged changes only
git show --format= --patch HEAD   # last commit only
git diff <actual-base>...HEAD     # branch / PR, after resolving its base
git diff HEAD -- src/foo.py       # named working-tree files
```

For working-tree or recent-session scope, inspect `git status --short` and
include relevant untracked files; diffs omit them. Do not add untracked or other
local edits to an explicit staged-only, last-commit, or branch/PR scope. An
explicit file list also limits which untracked files belong in the review.

For an unborn branch's working-tree scope, capture `git diff --cached` and
`git diff` separately, plus relevant untracked files. For staged-only scope,
use only the cached diff. Outside Git, use named files or recent session edits.
If no changed code can be identified, report that and stop.
