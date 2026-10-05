# Required lint baseline

Apply this baseline on every invocation. Enabling missing requirements, remediating findings, and recording the resulting policy are authorized by invocation; they are not optional recommendations. Preserve additional compatible repository checks. Resolve explicit instruction conflicts as described in [SKILL.md](../SKILL.md), and never claim full compliance with unresolved gaps or approved deviations.

## Principles

- Keep enforcement strict where it protects contracts, ownership, correctness, or meaningful performance guarantees.
- The number of enabled rules is not a safety metric, and a passing lint run is not evidence of type safety.
- Retain useful stylistic conventions, but do not describe them as type safety.
- Never delete vendored rule files. A rule that is off stays available, with its reason recorded beside the setting.
- Do not turn on a failing rule and hide the backlog behind a permanent package exclusion. Settle the policy, then migrate; an unfinished migration is not completed coverage.

## Required severities

| Rule | Setting | Reason |
| --- | --- | --- |
| `anti-slop/no-unknown-parameters` | error | Internal APIs take owner contracts. No name-based exemptions such as `cause`; narrow explained exceptions at real boundaries only. |
| `anti-slop/no-unknown-returns` | error | Same; an actual decoder stage may return unknown with an explained exception. |
| `anti-slop/no-unknown-type-aliases` | error | Aliasing unknown hides it. |
| `anti-slop/no-object-parameters` | error | Broad `object` erases the contract. |
| `anti-slop/no-unsafe-dictionary-type` | error | Open dictionaries lose key evidence; deliberate open mutable tables get contextual review. |
| `anti-slop/no-runtime-typeof` | `["error", { allowInTypeGuards: true }]` | Parse at boundaries; genuine predicates pass; already-typed union discrimination takes a narrow exception. |
| `anti-slop/no-known-value-widening` | error | Real evidence loss. Ensure the vendored rule does not flag inline objects, finite mapped keys, or predicate calls on typed values; correct it with tests if it does. |
| `anti-slop/no-widen-then-assert` | error | Widening to assert back is a cast in two steps. |
| `anti-slop/no-chained-type-assertions` | error | Same. |
| `anti-slop/require-safety-comment-for-type-assertion` | error | Comments are necessary, not sufficient; pair with type-aware assertion checking. |
| `anti-slop/no-reduce-accumulator-copy` + `oxc/no-accumulating-spread` | error | Growing copies are quadratic. Fixed-size snapshots may justify an exception. |
| `anti-slop/no-reflect-apply`, `no-reflect-get` | error | Prefer typed access; preserve real receiver and getter semantics with a concrete exception. |
| `anti-slop/no-module-mocking` | error | Prefer real seams; narrow exceptions for loader, runtime-compatibility, and failure-injection tests. |
| `anti-slop/require-readable-spacing` | error | Maintainability convention, autofixable. |
| `anti-slop/no-array-filter-map` | off, with reason | Both forms are linear; rewrites change callback order and sparse-array semantics without establishing performance. |
| `anti-slop/no-conditional-empty-object-spread` | off, with reason | Conditional spread preserves omission semantics without mutable builders. |
| `anti-slop/no-shape-in-symbol-names` | off, with reason | A substring cannot establish domain ownership; enforce naming in review. |
| `typescript/no-unsafe-assignment`, `-argument`, `-call`, `-member-access`, `-return` | error | Catches `any` escape routes that syntactic rules miss: untyped JSON, callback registries, SDK generics, stream reads. |
| `typescript/no-unsafe-type-assertion` | error | Independent of safety comments; audited narrow exceptions for real runtime evidence and malformed fixtures. |

Lint options: `denyWarnings: true`, `reportUnusedDisableDirectives: "deny"`, and type-aware checking enabled. Enable `typeCheck: true` where supported, or include an equivalent compiler check in the repository's normal validation command. Unsupported options are a tooling gap to resolve, not permission to skip the check.

Compiler requirements: `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`, explicit in the applicable TypeScript configuration. Ensure effective child configurations do not weaken them. Check maintained JavaScript with `allowJs` and `checkJs`; use owner-derived JSDoc types and resolve deployed imports to their actual checked sources where necessary. Adopt these requirements by owned contract with behavior tests, not by diagnostic spelling.

## Required coverage and rule behavior

Cover owned application code, tests, harnesses, scripts, and maintained JavaScript. Remove provider-wide, test-file, and other maintained-source exclusions that hide baseline findings. Keep explicit exclusions for third-party/vendor code, generated artifacts, and caches; do not reclassify maintained code to evade checks. Deliberately malformed fixtures and defective benchmark starting code need narrow explained exceptions preserving their purpose; check reference solutions and verifiers normally.

Verify these contracts with regression fixtures through the registered plugin and effective configuration; correct the installed rules with tests and provenance when needed:

- **Unknown parameters:** `cause`, `error`, and other spellings receive the same enforcement. Remove name-based exemptions; legitimate thrown-value boundaries use explained directives.
- **Module mocking:** recognize the repository's actual supported test-framework imports, including `vite-plus/test` when used. A rule enabled against an unrecognized import is not coverage.
- **Known-value widening:** preserve genuine evidence-loss diagnostics without rejecting precise inline objects, finite mapped keys, or typed predicate calls. Destructured bindings must use their selected property/element evidence, not inherit the initializer object's evidence.
- **Disable directives:** an unnecessary directive is an error. Test both a justified directive and its unused counterpart after removing the offending operation.

Each applicable rule probe must demonstrate both an accepted case and a still-rejected case. Reuse existing tests when they exercise the installed configuration; do not duplicate proven corrections merely to match a particular implementation.

## Adopting the baseline

When any required rule, flag, coverage, or behavior is missing:

1. Measure first, read-only. Run the candidate rule with `-D <rule> --format json` or a temporary config outside the repository, and rank findings by rule and file. Counts are diagnostics, not confirmed defects.
2. Classify findings: real defects, missing boundaries, legitimate permanent exceptions, and rule false positives.
3. Remediate by contract, persist the required settings and coverage, correct rule gaps, and record the decisions and reasons in the config, policy, and provenance record. Add missing checker dependencies or command wiring where needed, following repository tooling conventions.
4. Do not stage indefinitely. Several issues often fall to one cleaner contract; take that path when it is available.

## Recording the policy

Keep three records consistent:

- **Config** is the source of truth for severities. Every `"off"` and every `overrides` entry carries a one-line reason.
- **Plugin `UPSTREAM.md`** records source revision, local rule deviations, and points at the policy document.
- **Policy document** explains the refactor-before-exception procedure, per-family guidance, and any evaluation evidence. Mark historical measurements as historical, not as a backlog or as permission to keep exclusions.
