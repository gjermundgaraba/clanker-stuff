# Refactoring Toward a Deep Boundary

Use this procedure when reshaping existing code. Preserve observed behavior unless the user has explicitly agreed to a behavior change.

## Establish the baseline

Inspect real callers and characterize behavior at the current public boundary. Cover representative success, expected domain failures, unexpected failures, side effects, ordering, state transitions, transactions or partial writes, retry behavior, and diagnostics. Existing tests and documentation are evidence, but actual callers may depend on additional observable behavior.

Name the scattered decision or policy the new module will own. Identify bypass imports and duplicated orchestration. Distinguish accidental structure from necessary process, privilege, deployment, performance, or failure seams.

## Separate graph change from semantic change

Design an interface that can preserve the baseline before improving semantics. If the recommended contract changes behavior, present that as a substantive interface change and obtain agreement before implementation. Keep unrelated cleanup out of the migration when it would obscure whether behavior was preserved.

Replace caller orchestration with the agreed public operation while keeping transport adapters, framework entry points, or true external ports that still own a distinct responsibility. Internals may remain decomposed behind the boundary.

Migrate callers atomically when the boundary is private and the repository permits it. When compatibility requires an incremental migration, use a narrow adapter, move callers, verify remaining use, then remove the adapter and obsolete entry points. Do not create a compatibility layer without an actual consumer.

## Verify the refactor

Run characterization and contract tests through the new public boundary. Compare important results and side effects with the baseline, including failure after partial internal progress. Verify representative callers no longer select internal algorithms, coordinate phases, duplicate policy, or depend on private helpers.

Use native visibility, package exports, or an existing architecture check to prevent known bypasses when justified. Treat a green boundary rule as evidence of conformance only: a forwarding facade can pass while remaining shallow.

Report preserved behavior, any explicitly agreed changes, migrated and remaining callers, temporary adapters, and the evidence used to verify equivalence. If full preservation cannot be established, state the precise uncertainty and its impact.
