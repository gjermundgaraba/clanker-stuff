# Assess architectural findings

Substantiate candidate findings against code, contracts, and known constraints before presenting them. Account for rejected approaches, migration plans, temporary scaffolding, and planned follow-up work when that context is available.

## Evidence and judgment

- Trace the concrete execution path and relevant consumers. Check upstream validation and type guarantees before alleging an invalid state or missing boundary check.
- For proposals, show how a stated design decision would affect a requirement or existing contract. Identify the assumption behind a predicted problem instead of reporting it as an observed defect.
- Evaluate abstractions by demonstrated benefit in ownership, comprehension, reuse, or change isolation, weighed against added indirection and maintenance cost.
- Distinguish effective tradeoffs from defects. A preference for a different approach, an established pattern, or an unusual import graph is not evidence of harm by itself.
- Check apparent gaps in your understanding before deciding. Existing conventions do not excuse an evidenced problem, and unchanged code matters when it affects the scoped question.
- Scrutinize security and correctness concerns even when initially uncertain; include them as architectural findings when they reveal a boundary or contract problem.

Prioritize by demonstrated impact and reach. Group related findings and discard unsupported nits. Do not invent findings or suppress evidenced issues to meet a quota.

## Findings

For each supported finding, include:

- **Severity:** `structural`, `concern`, or `observation`, according to the consequence and reach of the issue.
- **Finding:** the affected components and specific ownership, boundary, coupling, or design problem.
- **Evidence:** concrete paths, symbols, and dependency or data-flow details; cite proposal sections for unimplemented designs.
- **Impact:** the practical cost to changeability, testing, reliability, or scale.
- **Counterevidence and confidence:** relevant constraints, guarantees, and unresolved assumptions. Confidence describes evidence strength, independently of severity.
- **Affected contract and constraints:** the responsibility or guarantee compromised, and existing requirements any later design must preserve.

For implemented changes, label each issue as introduced, worsened, or pre-existing. Keep proposed behavior distinct from verified implementation.

When useful for a decision, distinguish issues worth acting on now, issues with unresolved tradeoffs, and low-priority context. Explain material dismissed concerns when the reasoning affects the user's decision; omit routine rejected nits and empty groups.

Give supported conclusions and investigation limits without claiming that a review establishes readiness to ship.
