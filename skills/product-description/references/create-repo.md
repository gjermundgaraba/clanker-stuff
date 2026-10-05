# Create a repository

Use this route for a new product-description repository. For existing work, use [extend or revise](extend-repo.md).

## Scope and product shape

Infer established choices from the request and source repository. Default to one product surface per repository unless the user requests a combined specification or existing repository scope already includes multiple surfaces. Record the product and surfaces in scope, default role/configuration, exclusions, source path and inspected commit, documentation destination, and how to run each surface. Record whether documentation pins a source revision or follows changes. Ask only about unresolved choices that materially affect the work; unavailable runtime access need not block source-based drafting.

Inspect the source areas needed to locate interaction state, behavior tests, UI, and defaults. Record useful source locations in the README as a reference map, not a mandatory reading itinerary.

Consult the relevant product kind in [product-kinds.md](product-kinds.md). Establish the unit of interaction and its five phases, variant axis, interrupt list, and cross-cutting concerns. Put them in the README and glossary before drafting the pilot. Later changes to these shared conventions require updating affected documents consistently.

## Establish the repository

Use the requested destination; initialize Git for a new repository and preserve existing repository conventions. Adapt these templates:

| File          | Purpose and template                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `README.md`   | Scope, conventions, source map, planned structure, and coverage using [README-template.md](README-template.md) |
| `goal.md`     | Lead task, assignments, shared fact references, and completion using [goal-template.md](goal-template.md)      |
| `glossary.md` | Shared vocabulary using [glossary-guide.md](glossary-guide.md)                                                 |

Group the planned documents by how the user encounters the product, rather than by source package. Mark planned documents `not started`; revise the plan as evidence changes it.

Create a short `AGENTS.md` that routes by task. For example:

```markdown
Use README.md for scope, conventions, document structure, and coverage. Consult
the sections relevant to the current task. Use goal.md when selecting work or
coordinating assignments; an explicit document assignment defines worker scope.
For an edit, read the affected document and the glossary/foundations it relies
on; consult the pilot when establishing or recalibrating document structure.
The source repository is read-only. Shared glossary and plan edits have one
owner during parallel drafting; workers propose additions to that owner.
```

`CLAUDE.md` can point to `@AGENTS.md` without duplicating these instructions.

## Establish exemplars and draft

Write a small, self-contained pilot using [document-template.md](document-template.md). Settle the template, tone, terminology, and coverage of applicable observable behavior; length is not a completeness test.

Write the foundations needed by dependent features so they own shared numbers and rules. Record concise references to established facts in `goal.md`. For a tightly coupled area, trace the states and handoffs needed to decide which document owns each behavior before drafting dependent documents.

Draft the remaining features. If parallel work is appropriate and available, assign independent documents or small clusters. Give each worker its source revision, relevant conventions and foundations, an exemplar when needed, and this scope:

> Write only the assigned documents using the established skeleton and vocabulary.
> Preserve source provenance and distinguish it from observed verification. Report
> unknowns, suspected defects, and proposed glossary additions to the lead. Do not
> edit the source repository, shared glossary, coverage table, or other workers'
> files. You are not alone in the workspace; preserve others' edits. Your assignment
> does not include finishing the repository's remaining work.

The designated shared-file owner integrates terminology and tracking changes. Review results for supported claims, shared facts, interrupt coverage, and links; mark accepted documents `drafted`.

## Reconcile and continue

Check consistency across the new set: each shared fact has an owner, terminology agrees, applicable table cells are filled, provenance and observation status are present, and the structure/coverage table reflects the plan and files. Resolve this skill's directory from the loaded `SKILL.md` and check links with:

```sh
node {skill-directory}/scripts/check-links.mjs {description-repo}
```

Revisit documents when missing evidence, unresolved questions, or inconsistencies justify it. A thin open-questions section does not by itself require more work.

For a full build, proceed to [verification and triage](verify-triage.md), producing `verification/README.md`, checklists, and `bug-triage.md`, and run available observations. A request explicitly limited to drafting ends with consistent drafts and clearly reported unobserved claims. Follow repository conventions for authorized commits of coherent work.
