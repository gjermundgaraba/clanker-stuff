# Review a requested GitHub PR

Use an isolated clone if the current checkout contains unrelated work. Fetch the requested PR and its actual base instead of assuming `main`. Run this preparation in a shell that stops on failures:

```bash
set -e
review_dir=$(mktemp -d)
git clone https://github.com/OWNER/REPO.git "$review_dir"
cd "$review_dir"
pr_number=42
pr_base=$(gh pr view "$pr_number" --json baseRefName --jq .baseRefName)
gh pr checkout "$pr_number" --detach
git fetch origin "$pr_base"
base_oid=$(git rev-parse FETCH_HEAD)
head_oid=$(git rev-parse HEAD)
git diff --binary "$base_oid...$head_oid" > "$review_dir/pr.diff"
```

The diff includes every changed path, including deletions and names containing whitespace. If the PR updates during preparation, refetch and capture a consistent head/base before claiming current coverage. For a historical review use the requested immutable revisions. State any context or binary-content coverage limits; do not silently truncate the file list.

```bash
opencode run --agent plan \
  "Review PR $pr_number against base $base_oid and head $head_oid using the complete attached diff and this checkout. Report grounded bugs with file/line evidence and coverage limits. Do not edit, commit, or post." \
  --file "$review_dir/pr.diff"
```

Use a permission configuration or external read-only sandbox if writes must be prevented; plan mode and the prompt are not an OS sandbox. The isolated clone protects the user's current checkout but does not prevent other side effects. Supply relevant surrounding files when needed, including binary context that a diff cannot explain. Preserve the full requested review scope. If context limits require batching, review that scope in deliberate batches. Report any unfinished coverage explicitly; do not present a partial review as complete.
