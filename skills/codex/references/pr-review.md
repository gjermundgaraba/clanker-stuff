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

After preparation, run a report-only review in the clone:

```bash
codex exec --sandbox read-only \
  "Review PR $pr_number using git diff $base_oid...$head_oid. Inspect surrounding files as needed. Do not edit or post. Return grounded findings and coverage limits."
```

Use each PR's actual base for batch reviews. Keep separate checkouts for concurrent jobs, and return findings locally unless posting is authorized.
