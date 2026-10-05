# Test value

Judge tests by the supported failures they detect, the clarity of their
diagnosis, and their maintenance cost. Keeping or strengthening a test
can be more valuable than removing it.

## Protection and overlap

Inspect what existing tests assert, not merely which code they execute.
Similar tests may protect different boundaries or provide useful failure
isolation. Consolidation is worthwhile only when it preserves those benefits.

Do not treat passing checks after a deletion as proof of equivalent coverage.
Support redundancy findings with the specific surviving assertions relied on.

## Assertion strength

Consider whether a plausible incorrect implementation would still pass.
Watch for permissive assertions, expectations copied from the implementation,
and other components compensating for the defect under test.

For isolated validation cases, otherwise-valid input helps establish that
the intended defect caused rejection. Deliberate multi-error and precedence
tests have a different purpose.

## Contracts versus incidental details

Exact values can be essential for persisted data, wire formats, or other
stable interfaces. They are less useful when they merely freeze incidental
wording or implementation structure.

Dependency-facing tests can protect concrete compatibility assumptions.
Do not confuse those with broadly retesting a dependency.

## Supporting machinery

Before calling fixtures, helpers, or exports unnecessary, check their
remaining consumers. Documented manual workflows are legitimate consumers;
absence of automated callers does not establish dead code.

## Contrasting examples

- A downstream editor's own cap can hide a missing cap in our code.
  Observing the seed boundary tests our decision; a separate wiring test
  can establish that seeded history is actually usable.
- A generic rejection assertion can pass because an unrelated field is
  invalid. A distinguishing error assertion protects the intended validation.
- Importing the same persisted identifier into both implementation and
  expected fixture can hide incompatible drift. An independent literal
  may be deliberate contract coverage.
- A narrow host-hook-order check can protect a production compatibility
  assumption, even though the ordering is implemented upstream.

Apply the parent skill's scope and reporting rules. These examples are
decision aids, not categorical deletion rules.
