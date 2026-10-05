# Architectural Critique Rubric

Apply only the lenses relevant to the review scope. Prefer observed problems and plausible near-term changes over hypothetical flexibility. For proposals, tie predicted consequences to stated requirements and existing contracts, and identify assumptions that need validation.

## Abstraction Fit

- Does each abstraction represent a real concept and separate things that change independently?
- Is business logic isolated from framework wiring?
- Is there accidental coupling, needless indirection, or a missing boundary?
- Must callers reconstruct a workflow or learn internal decisions that the abstraction should own? Check a real consumer before diagnosing leakage. When considering consolidation, ask whether it would hide complexity or merely relocate it.

## Data and State

- Do data shapes match runtime behavior and access patterns?
- Does code repeatedly reshape data because the model is wrong?
- Are ownership, lifecycle, consistency, and failure behavior clear?

## Boundary Discipline

- Are validation and error handling placed at system boundaries?
- Does data cross boundaries in explicit, honest shapes?
- Can the subsystem be exercised without starting unrelated parts of the system?
- Do dependency cycles or imports of internals undermine an actual ownership rule? Trace the relationship and its cost rather than treating the shape of the import graph as a defect.

## Failure Contracts and Verification

- Can consumers distinguish failure from a successful empty result? Trace how error information reaches the caller or operator and identify any loss that changes their decisions.
- Where are external values established as trusted domain data? Check upstream guarantees before alleging that a cast or default bypasses validation.
- Do tests exercise important cross-boundary behavior, including failure and cleanup? Judge observable contract coverage, not whether every source file has a matching test file.

## Evolution Readiness

- Would a likely next requirement stay localized or spread across the system?
- Are current hardcoded assumptions or obsolete compatibility paths already costly?
- Is the feature integrated with established extension points or bolted on beside them?
- Which consumers, persisted data, or deployment steps constrain a contract change? Assess compatibility obligations and, when breaking changes are authorized, whether the scoped change leaves callers inconsistent or legacy paths without a current purpose.

## Complexity and Consistency

- Is complexity concentrated where the domain requires it?
- Could existing language, platform, or codebase mechanisms replace custom machinery?
- Does the subsystem follow local patterns, and are meaningful deviations justified?

File length, import counts, and navigation effort can guide inspection but do not establish a structural problem. A large cohesive implementation can hide complexity well; splitting it may make callers do more work. Likewise, familiar design principles and local consistency are lenses, not compliance requirements.

A simple design is not under-architected merely because it lacks speculative extension points. Report local bugs only when they demonstrate an architectural issue; do not turn this review into a general lint or type-safety audit.
