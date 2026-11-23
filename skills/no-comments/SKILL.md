---
name: no-comments
description: "Spawn Comment Sicko, fix accepted findings, and offer encodings for claimed constraints."
disable-model-invocation: true
license: MIT
metadata:
  upstream-source: "https://github.com/cursor/plugins"
  upstream-path: "pstack/skills/no-comments/"
  upstream-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "recorded"
  upstream-sicko-source: "https://github.com/cursor/plugins"
  upstream-sicko-path: "pstack/agents/comment-sicko.md"
  upstream-sicko-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-sicko-relationship: "adapted"
  upstream-sicko-license: "MIT"
  upstream-sicko-license-file: "LICENSE"
  upstream-sicko-baseline-kind: "recorded"
  upstream-why-source: "https://github.com/cursor/plugins"
  upstream-why-path: "pstack/skills/why/"
  upstream-why-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-why-relationship: "adapted"
  upstream-why-license: "MIT"
  upstream-why-license-file: "LICENSE"
  upstream-why-baseline-kind: "recorded"
  upstream-architect-source: "https://github.com/cursor/plugins"
  upstream-architect-path: "pstack/skills/architect/"
  upstream-architect-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-architect-relationship: "adapted"
  upstream-architect-license: "MIT"
  upstream-architect-license-file: "LICENSE"
  upstream-architect-baseline-kind: "recorded"
  upstream-root-causes-source: "https://github.com/cursor/plugins"
  upstream-root-causes-path: "pstack/skills/principle-fix-root-causes/"
  upstream-root-causes-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-root-causes-relationship: "adapted"
  upstream-root-causes-license: "MIT"
  upstream-root-causes-license-file: "LICENSE"
  upstream-root-causes-baseline-kind: "recorded"
  upstream-redesign-source: "https://github.com/cursor/plugins"
  upstream-redesign-path: "pstack/skills/principle-redesign-from-first-principles/"
  upstream-redesign-revision: "2f87c854fe3e2fcda44ca86b46ede35aad3c46b7"
  upstream-redesign-relationship: "adapted"
  upstream-redesign-license: "MIT"
  upstream-redesign-license-file: "LICENSE"
  upstream-redesign-baseline-kind: "recorded"
---

# No comments

Spawn Comment Sicko. Act on accepted findings.

Defer to Comment Sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Snapshot

The scope can include uncommitted work, so review and revert only Comment Sicko's edits. Use `scripts/snapshot.sh` beside this file, by its absolute path. It records staged, unstaged and untracked files without writing to the repository's `.git` or index, and works from any directory in the repository.

- `snapshot.sh take` prints a snapshot directory. Shell state may not persist between calls, so pass it literally as `<snapshot>`.
- `snapshot.sh diff <snapshot> [git diff options and paths]` shows every edit made since `take`.
- `snapshot.sh restore <snapshot>` reverts every edit made since `take`, including created and deleted files, and leaves the index alone.
- `snapshot.sh drop <snapshot>` deletes the snapshot directory. Drop it whenever `/no-comments` ends, whether it succeeds or fails.

## Steps

1. Take the snapshot. Invoking this skill is the user's explicit request to delegate the review, so spawn a subagent for it and never follow `references/comment-sicko.md` yourself. The subagent must be able to edit files and must start without this conversation's history: in Claude Code, a new agent rather than a fork; in Codex, `spawn_agent` with `fork_turns: "none"`. Brief it with `Read <path> and follow it.`, where `<path>` is the absolute path of `references/comment-sicko.md` in this skill's folder, and pass the scope. Do not restate its rules. If the host cannot spawn a subagent, stop and fail `/no-comments`.
2. Inspect its report and its `snapshot.sh diff`. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, trace their symbol or trace their rationale per [references/rationale.md](references/rationale.md). If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert one rejected report with `snapshot.sh restore` and rerun it in a fresh subagent with the original brief and the failure named. Reject a second, revert it with `snapshot.sh restore` too, report it open, and fail `/no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, sketch it once for the accepted set and surrounding code. Trace every system the change touches, then sketch two different shapes (types, signatures, module boundaries) and pick the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. Stop at the sketch. The sketch shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. Two principles guide intent only. Fix the fault, not the place where it surfaced: the root cause is the first place the system did something it should not do, and a guard is a fix only when the state it handles is legitimate. Do not bolt the fix onto the existing design; shape it as if its requirement had been a foundational assumption from the start. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended runs require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, design sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
