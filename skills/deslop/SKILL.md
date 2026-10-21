---
name: deslop
description: Review a diff, files, or other explicit scope for slop (unnecessary code, overengineering, ceremony that does not pull its weight) and report findings without editing. Use when the user or a delegating agent asks for a deslop or slop review, asks whether code is overcomplicated or could be simpler, or names this skill in a prompt, brief, or pasted text such as `/deslop` or `$deslop`. Not for code review that does not ask about complexity.
---

# Deslop

Review the full user-provided diff, files, or explicit scope for slop: unnecessary code, overengineering, or ceremony that doesn't pull its weight. Report findings without applying fixes unless requested.

Deliver diagnosis and evidence. Do not prescribe replacements, implementation steps, or a target design unless requested. A supported finding does not require a known solution.

## Resolve a diff review's scope

- For changes introduced by a branch or PR, identify its intended target and review from the merge base of that target and the branch. Use the PR base when supplied; otherwise inspect the available target refs. A stale local branch is not the target's current state. Unrelated changes already in the target are outside this review, even if the stale local-branch diff includes them. Naming `main` as the target does not by itself request a literal comparison with `refs/heads/main`.
- Honor an explicitly requested revision range, commit, or literal local-ref comparison exactly, including its endpoints and two-dot or three-dot meaning. Do not substitute a newer remote ref for that request.
- State the resolved base and scope. If available evidence cannot resolve a material ambiguity, ask the focused question needed before presenting findings as belonging to the branch or PR.
- For a diff review, report complexity the diff introduces, materially changes, or leaves unnecessary, such as code whose last caller it removes. Unchanged code the diff does not affect stays outside the review, even when read for context. Full-file and repository reviews keep their requested broader scope.

## Output

- Lead with findings, ordered by practical impact, or say there are no slop findings.
- For each finding, include a file reference, the unnecessary mechanism, the behavior it currently supports, and evidence that its complexity is avoidable. Explain the maintenance or comprehension cost, relevant constraints, and unresolved assumptions without prescribing an edit.
- Report any skipped or unfinished coverage and the reason.

## What to look for

**Rules and documentation conformance**

- Comments where the code already speaks for itself. A comment recording a constraint the code cannot show (a lint, complexity, or platform limit; an ordering, race, or retry reason; why a guard or split exists) is not slop.

**Type safety and source of truth**

- Unnecessary casts, aliases, redefinitions
- Defensive guards or null checks proven redundant by types, validated boundaries, or enforced invariants; rarity alone is not evidence

**Overengineering**

- Abstractions, wrappers, helpers, or indirection that add complexity without a current benefit
- Duplicated implementations, unused flexibility, or configuration, dependencies, and files without a concrete need
- Hand-maintained copies of an existing source of truth (lists, tables, switches, or enums mirroring a registry or schema) that must be edited in sync. Sweep every file in scope for them. A plausible reason for the copy is not enough if deriving from the source could meet it (e.g. sorting keys for a stable order).
- Custom machinery that suitable existing code, standard-library functions, native features, or installed dependencies could replace
- Belt-and-suspenders handling: multiple guards, fallbacks, validations, wrappers, or retries protecting the same invariant without a concrete failure mode
- Compatibility shims, migrations, deprecated paths, or old API/config shapes kept after their compatibility obligations have ended. Require evidence that consumers or persisted state no longer need them; assume breaking compatibility is acceptable only when the user or project establishes that scope.
- Placeholder logic or debug leftovers with no current purpose

**Tests**

When the requested review includes tests, use [the test-value guidance](references/test-value.md) to assess their protection, assertion strength, and maintenance cost. When executing temporary probes, isolate mutable build outputs from other source trees and concurrent builds, and verify that the intended tests ran against the probe source before citing the result.

- Tests with no meaningful contract coverage
- Test complexity disproportionate to the behavior asserted
- Tests for removed functionality: stale tests preserving retired behavior, or new assertions whose only purpose is to prove a removed feature is gone (e.g. invoking deleted commands to check they do nothing, or asserting retired tools/config fields are absent). Identify assertions and dedicated setup that no longer enforce a current contract.
- Distinguish removal-only assertions from negative tests enforcing a current contract, such as rejecting unsupported input or preventing unauthorized actions. Retain those when backed by a current requirement; the fact that a feature was removed is not by itself a reason to test its absence.
- Mocks that obscure or fail to exercise the relevant behavior

## Boundaries

- Stay within the requested scope; inspect relevant callers, contracts, and invariants far enough to support findings. When the scope imports a library with an installed conventions skill, such as `effect`, load that skill before judging its idioms.
- Prefer clear, maintainable code over fewer lines. A single implementation alone does not prove an interface is unnecessary.
- Account for required behavior, including validation, data-loss protection, security, accessibility, compatibility, and calibration, before judging a mechanism unnecessary. When fixes are requested, confirm a replacement covers the relevant requirements before recommending or applying removal.
- Harmless slop is still slop: flag unnecessary code, fallbacks, comments, and test complexity even when they cause no bug.
