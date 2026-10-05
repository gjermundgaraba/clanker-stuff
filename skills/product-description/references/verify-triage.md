# Verification and triage

Use this route for checklist creation, observation of the running product, and collecting or reconciling suspected defects. Scope the work to the requested documents; a full repository build covers the whole set.

## Checklists and observation

Use [verification-template.md](verification-template.md) for `verification/README.md` and one checklist per document cluster. Existing repositories retain their protocol and stable IDs. Each observable claim needs a linked checklist item, setup, expected result, priority, and a way to record the observation.

Identify the running surface, tested build/commit, and conditions. Choose a method capable of exercising each claim: scripts can observe CLI output, exit codes, and stored state; visual and input claims need suitable rendering and interaction evidence. Reading code or test definitions does not count as running the product. Running a test qualifies only for the claims it actually exercises on the identified build.

Run the available observations within the task's authorization and record `pass`, `fail`, or `blocked` with evidence and method. Continue with independent items when a device, account, build, or condition is unavailable. Record unobserved claims and coverage gaps rather than inferring success. Repeat affected observations when fixes or new evidence justify it.

Update each tested document's `Observed verification` footer with date, build/commit, method, coverage, results, and checklist link, retaining its source provenance. Apply the coverage criterion in the verification template: all P1/P2 claims must have been observed and either passed or failed with the failure recorded in triage; blocked or unrun P1/P2 items keep the document `drafted`. `verified` describes observation coverage, not a defect-free product. Automation can establish that coverage when it exercises the claims. Record human acceptance separately only when the user or repository requires it.

## Triage and corrections

Use [bug-triage-template.md](bug-triage-template.md) to collect suspected defects from the scoped documents and failed observations. Deduplicate supported common causes; retain links to every document or checklist that raised the issue. A failed item may reveal an incorrect document rather than a product bug: reconcile the document, checklist, and triage status accordingly. The source repository remains read-only.

Add source locations where the cause is known, severity, reproduction steps, and the decision needed. Report unknown causes honestly. Reuse existing triage IDs and update statuses when observations confirm, fail to reproduce, or correct a report.

Filing upstream is a separate action requiring user authorization. Use the repository, format, and publication scope already established in the conversation or repository conventions. Ask only for missing information or authorization that materially affects filing; do not reconfirm supplied decisions. The bug-triage template describes how to record issue links after filing.

## Completion

Checklist-only work ends with usable checklists and observation status left unrun. Observation and triage work ends when the scoped available observations are recorded, findings are reconciled, affected documentation/tracking is updated, and remaining blockers are explicit. A full-build lead continues here after drafting; a drafting worker's completion does not end this stage. Do not report unrun or blocked claims as verified.
