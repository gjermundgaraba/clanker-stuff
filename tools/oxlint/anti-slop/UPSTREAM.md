# Anti-slop provenance

## Source and installed files

The source repository and exact pristine revision are recorded in [UPSTREAM](UPSTREAM).
Assets came from `skills/install-anti-slop/assets/anti-slop/` at that revision.
The installed directory is `tools/oxlint/anti-slop/`; the generic entry point is
`index.ts`. The copied Effect entry point, `effect/index.ts`, is not registered:
no workspace package directly depends on Effect.

Keep the root MIT [LICENSE](LICENSE), the nested
[Stylistic license](vendor/eslint-stylistic/LICENSE), and its independent
[provenance](vendor/eslint-stylistic/UPSTREAM.md). No Stylistic runtime dependency
is required. The upstream test suite is recoverable at the revision in `UPSTREAM`.

## Local deviations

- `rules/no-known-value-widening.ts` follows initializer evidence only for
  identifier bindings. Destructured bindings select properties/elements and must
  not inherit the initializer object's type evidence. It no longer treats passing
  typed values to predicates as widening: narrowing unions and validating domain
  refinements do not erase the caller's type.
- `shared/dictionary-types.ts` does not classify precise inline objects or finite
  mapped keys as broad widening targets. This incorporates the independently
  tested `clankerusage` correction without losing the local destructuring fix.
- `rules/no-unknown-parameters.ts` removes the `cause` spelling exemption. Actual
  exception boundaries use the same explained-exception policy as other decoders.
- `rules/no-module-mocking.ts` also recognizes `vi` imported from
  `vite-plus/test`, this repository's only test entry point. Upstream matches
  `vitest` alone, so the rule never fired here.
- The nested Stylistic provenance clarifies that its development test commands
  refer to upstream rather than this consumer repository.
- The root license and provenance records are consumer-owned additions.

Regression tests for rule deviations live in `tools/oxlint/tests/`. All other
vendored rule implementations retain the pristine baseline behavior.

## Rule policy

`vite.config.ts` is the source of truth for enabled rules. The conditional empty
object spread, adjacent filter/map, and `shape` substring bans are off: they
enforce syntax without establishing omission safety, useful performance, or domain
ownership. All other generic rules are errors. `no-runtime-typeof` uses
`allowInTypeGuards: true` so
handwritten boundary predicates and assertions can perform their validation.
The rule remains syntactic: legitimate typed-union discrimination, arbitrary-value
diagnostics, and runtime adapters take narrowly justified exceptions rather than
one-use wrappers or primitive schema substitutions.

Follow [the repository lint policy](../../../docs/lint-policy.md) for every
exception. Strongly consider cleaner, more correct refactors first, including
breaking owned APIs and updating their callers. Exceptions must protect concrete
invariants, not preserve avoidable design debt.

Native type-aware unsafe-flow and unsafe-assertion rules complement the syntactic
rules. Compiler strictness, exact optional properties, and unchecked indexed
access are explicit in `tsconfig.json`. There are no provider-wide unknown or
test-file module-mocking policy exclusions.

A genuine schema boundary, serializer sink, or third-party seam takes a
line-level disable that states the reason. Unused disable directives are errors.
