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
claude -p "Review the supplied PR $pr_number diff against base $base_oid (head $head_oid). Return grounded bugs with file/line evidence; do not edit or post comments." \
  --tools '' --output-format json < "$review_dir/pr.diff"
```

For repository browsing, use `--tools 'Read,Grep,Glob'` and provide the diff plus relevant checkout paths. Precompute shell-derived context outside the reviewer. Validate findings against the code before returning them. `--from-pr` is only useful when intentionally resuming a session already linked to that PR.
