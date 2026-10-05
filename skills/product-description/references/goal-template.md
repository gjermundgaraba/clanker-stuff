# goal.md template

`goal.md` records the lead's current scope, shared fact references, assignments, and completion criteria. Consult relevant sections when planning or coordinating work; a worker receives only the context needed for its assignment. Replace `{...}` with the project's choices.

---

# Goal: {current requested outcome for the product description}

## Scope and source

Work in `{description repo}` on {the requested documents or full repository}. The source repository at `{source path}` is read-only. Describe {surface, role, configuration}; {exclusions} are out of scope. Inspected revision: `{sha}`. Versioning policy: {pin this revision / follow changes with per-document provenance}.

The lead owns {drafting, consistency, checklist creation, observation, and/or triage, as requested}. Workers own only their explicit document assignments; the remaining coverage table does not expand those assignments.

## Context by task

- Use README scope and conventions for the applicable product and document structure. The coverage table is the work list when selecting new work.
- For an edit, read the affected document and the glossary/foundations it depends on. Consult `{pilot}` when establishing or recalibrating structure; it is a coverage example, not a length target.
- Inspect source state handling, shared pipelines, tests, UI, and defaults where they establish the claims being documented. Useful locations: {paths and responsibilities}. This is a reference map, not a required reading order.

## Shared facts and ownership

{Concise pointers to facts already established in foundations: thresholds, defaults, state handoffs, restrictions, and terminology. Link to the owning document rather than copying its definitions here. Revisit a fact when new evidence or the requested source revision changes it.}

During parallel work, {the lead or designated owner} integrates `glossary.md`, README structure/coverage, and other shared-plan changes. Workers edit only assigned documents and report proposed terminology, dependencies, unknowns, and suspected defects to the owner. Everyone preserves other contributors' work.

## Drafting contract

- Follow the established eight-section feature skeleton, user-visible state diagram, and fixed variant/interrupt tables. For any document, mark genuinely inapplicable sections or phases with a reason, or omit them where repository conventions allow; follow the document template's distinction between "not applicable" and "no effect".
- Describe what the user sees and does. Use `> Technical note:` only where a mechanism changes the expected experience. Use the glossary's words, sentence-case headings, and concrete language that preserves material uncertainty.
- Link to shared facts instead of repeating them. Every applicable state, variant, interrupt, and cross-cutting concern is accounted for, including explicit “no effect” cases.
- End each document with `## Open questions and verification`, the inspected source provenance, and separate observation status. A draft starts with `Observed verification: not run`; a pass records date, tested build/commit, method, coverage, results, and checklist link.
- State unknown behavior and suspected defects plainly. Continue independent work without guessing. Integrate proposed glossary additions before accepting a draft.

## Work and completion

Current assignments and dependencies: {documents, owners, and needed foundations/exemplars}. For a new build, establish the pilot and required foundations before dependent drafts; trace tightly coupled handoffs before assigning their documents. For an extension, use the existing exemplars and affected dependencies.

A drafting worker is done when its assigned documents satisfy the drafting contract, relevant consistency checks are complete, and proposed shared-file changes and unresolved questions are reported to the lead. It does not edit unassigned documents or claim that the entire repository is complete.

The lead is done when {the requested scope} is complete, shared terminology and tracking are integrated, and consistency issues caused by the work are resolved. When the task includes observation and triage, continue through the available observations and reconcile findings; list blocked or unobserved claims explicitly. Drafts alone do not complete that wider task. Determine verified coverage from observed evidence; track any required human acceptance separately.

Use the repository's conventions for authorized commits of coherent completed work. Further reading, revisions, or repeated checks should address dependencies, changed claims, failures, or unresolved evidence.
