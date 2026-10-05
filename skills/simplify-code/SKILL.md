---
name: simplify-code
description: "Parallel 3-agent cleanup of recent code changes. Use only when explicitly asked to invoke this skill."
disable-model-invocation: true
---

# Simplify Code

By default, run three read-only reviewers for reuse, quality, and efficiency in parallel,
combine their findings, and apply worthwhile cleanup within the requested scope.

## Invocation

- **Focus:** for a requested `reuse`, `quality`, or `efficiency` focus, run only
  that reviewer unless all three were explicitly requested. When all three are
  requested with a focus, prioritize findings relevant to that focus.
- **Dry run:** “just report” or “don't change anything” means findings only.
- **Scope:** honor staged-only, last-commit, branch/PR, or named-file boundaries.
  Otherwise review uncommitted changes or recent session edits.

## Capture the scope

Capture the complete requested scope using [scope guidance](references/scope.md) as needed. Include relevant untracked files for working-tree scope; exclude unrelated local edits from staged-only, last-commit, and branch/PR reviews. If no changed code can be identified, report that and stop.

Give each reviewer the absolute repository path, applicable project instructions,
and the complete captured scope. If it exceeds context, review coherent batches
with all active reviewers receiving the same complete batch and relevant
cross-file context. Track coverage across batches; do not silently truncate or
assign disjoint fragments to different reviewer categories.

## Run the reviewers

Confirm that the required reviewers can run with read/search access. If any
required reviewer cannot start or finish the captured scope, stop and report
the blocker without applying cleanup. Do not proceed with fewer reviewers or
substitute a lead-only review.

Submit all active reviewers before waiting. Give them read/search tools to
inspect callers, tests, and existing implementations. They must not edit files,
run formatters, create worktrees, or commit.

1. **Reuse:** find duplicated functionality that an existing utility or pattern
   already supplies. Name the replacement and its location; do not speculate
   that a helper probably exists.
2. **Quality:** find redundant state, unnecessary indirection, leaky boundaries,
   unchecked casts, or avoidable complexity. Establish the behavior and purpose
   before recommending removal; use history such as `git blame` only when
   code, callers, and tests leave that purpose unclear.
3. **Efficiency:** find consequential redundant work, broad reads, N+1 calls,
   avoidable blocking, or resource leaks. Explain the concrete cost or failure
   and why the proposed fix improves it. Inspect error-handling intent before
   treating an ignored error as a bug.

For each finding, give the code location, proposed change, supporting evidence,
and practical benefit. Explain material uncertainty or validation still needed;
confidence and risk labels are not required. Skip style-only churn.

Do not remove code whose purpose remains unclear. Check
dynamic consumers before removing exports; dead-code tools alone are not proof.

## Combine and apply

Wait until every required reviewer has completed the captured scope before
applying any cleanup, including when the review spans multiple batches.

1. Merge and deduplicate the active reviewers' findings; discard unsupported
   suggestions. Resolve conflicts by correctness, then the user's focus,
   readability/reuse, and demonstrated performance needs.
2. Apply supported cleanup that preserves required behavior and stays within
   the authorized scope, in coherent groups that preserve existing user edits.
   Keep edits within the reviewed changes and necessary surrounding code allowed
   by the request. Defer changes when behavior preservation is uncertain or the
   proposal exceeds that scope; explain the missing evidence or decision needed.
   In dry-run mode, report findings without editing.
3. Run appropriate repository checks for affected behavior, including required
   tests/build/lint/type checks. Repeat when failures or further edits justify
   it. Diagnose failures and fix or undo only the offending change.
4. Report applied fixes, deferred findings and reasons, validation results, and
   any unreviewed scope or unresolved failures.
