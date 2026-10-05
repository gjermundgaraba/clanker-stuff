# Read-only multi-agent review pattern

Use this when the user asks for Claude Code to review code with multiple subagents and return findings before any changes.

## Why this pattern exists

Tool-enabled print-mode reviews can exhaust their turn budget while reading, leaving no useful stdout. A focused evidence bundle and bounded no-tools calls provide a read-only fallback. Because reviewers cannot fetch missing context, bundle coverage is part of review correctness.

## Workflow

1. Establish the requested files or diff and its actual base/head. Include domain references only when relevant; prefer repository-compatible installed sources.
2. Bundle the scoped diff, its changed-path inventory, and the surrounding source, tests, configuration, or callers needed to judge it. Derive paths from the request and diff, without filtering by language extension. Preserve deleted content and both sides of renames. Inspect the bundle for missing context, generated output, or secrets before dispatch. Split a large scope into explicit review units rather than silently truncating it.
3. Honor an explicitly requested reviewer count. Otherwise choose enough distinct lenses for the scope: two may cover a small multi-reviewer task, while a broader change may benefit from more. Run independent reviewers in parallel when supported.
4. Use `--tools ''` for each no-tools reviewer and a finite host timeout or supported CLI budget. All required evidence must be supplied in the prompt. Ask reviewers to identify material coverage gaps instead of guessing.
5. Validate and deduplicate findings against the evidence in the current agent. Add a separate no-tools coordinator only when requested or when the volume or conflicts justify another pass; give it the relevant bundle and reviewer outputs. Resolve material gaps before claiming coverage, or state the unresolved limit.
6. Compare repository state before and after; report whether files changed based on that comparison. Configured hooks and MCP tools need separate consideration; `--tools` controls built-in tools, not those surfaces or OS permissions.

## Example: committed diff bundle

Capture immutable `base_oid` and `head_oid` for the requested comparison first. For a PR, follow [PR review](pr-review.md), then set `base_oid=$(git merge-base "$base_oid" "$head_oid")` to match its three-dot diff; comparing the latest base tip directly can include unrelated base changes. This example covers committed changes. For working-tree or staged reviews, use the corresponding diff and explicitly include requested untracked files, which `git diff` does not contain.

```bash
set -e
: "${base_oid:?Set the requested base revision first}"
: "${head_oid:?Set the requested head revision first}"
review_dir=$(mktemp -d)
review_paths=() # All changed paths; set pathspecs only for a requested narrower scope.
{
  printf 'BASE: %s\nHEAD: %s\n' "$base_oid" "$head_oid"
  git diff --name-status --find-renames "$base_oid" "$head_oid" -- "${review_paths[@]}"
  git diff --no-ext-diff --no-textconv --find-renames --unified=40 \
    "$base_oid" "$head_oid" -- "${review_paths[@]}"
} > "$review_dir/code-review-bundle.txt"
```

The patch includes TSX, Python, deletions, and other changed text paths. It supplies nearby context, not necessarily all relevant code. Append needed full files or excerpts from the captured revisions, labeling their path and revision; retrieve deleted-file context from the base. Binary changes need appropriate separate evidence or an explicit coverage limit. Review the final bundle before sending it to the worker.

Run one bounded call per selected lens, using the user's model/effort and installed-version budget options. For example, the runtime lens receives:

```bash
claude -p \
  'Review runtime correctness using the supplied diff and context. READ ONLY. Return concrete findings with file/line evidence and identify any material missing context.' \
  --tools '' --output-format text < "$review_dir/code-review-bundle.txt" \
  > "$review_dir/review-runtime.txt"
```

Other lenses might cover architecture/API or tooling/integration/tests when those concerns are present. Synthesize the selected outputs after checking their evidence; a fixed reviewer panel or extra coordinator is not required by this example.

## Pitfalls

- Do not let reviewer agents edit or run broad shell commands when the user explicitly asked for output before changes.
- If a tool-enabled review hits max turns with empty output, do not keep increasing turns blindly. Switch to pre-bundled, no-tools review.
- Treat reviewer output as claims. Validate findings against code evidence before returning them to the user.
- Do not save session-specific findings as durable memory; review output belongs in the session or, when requested, in the project issue tracker.
