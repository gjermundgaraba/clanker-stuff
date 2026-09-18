# Lint policy evaluation

Evaluated on 2026-09-18 against commit `8e62004`. The recommendations below were
accepted; this document preserves the pre-migration measurements and rationale.
The authoritative policy is [lint-policy.md](lint-policy.md); active enforcement
is in `vite.config.ts` and `tsconfig.json`. Counts below are historical, not a
current backlog or permission to retain exclusions.

## Recommended end state

Strictness should protect contracts, ownership, runtime behavior, and meaningful
complexity bounds. The number of enabled rules is not a safety metric. Retain
useful stylistic conventions, but do not describe them as type safety.

| Area                                                                  | Recommendation                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown parameters                                                    | Keep an error for internal APIs; remove the `cause` spelling exemption. Use narrow, explained exceptions at real boundaries, not naming-based exemptions.                                                  |
| Runtime `typeof`                                                      | Retain the implemented `allowInTypeGuards: true` policy and narrow exceptions. A predicate signature is permission to validate, not proof of validation.                                                   |
| Conditional empty-object spread                                       | Disable the blanket ban. Preserve omission semantics; refactor complex construction when that improves the contract or control flow.                                                                       |
| Known-value widening                                                  | Keep enforcement of actual evidence loss, but fix inline-object and finite-key false positives and remove the unsupported inference that passing a typed value to a predicate necessarily loses evidence.  |
| Unsafe `any` flow                                                     | Adopt type-aware assignment, argument, call, member-access, and return rules for TypeScript after remediation. Track JavaScript evaluation tooling separately rather than silently treating it as covered. |
| Unsafe type assertions                                                | Adopt type-aware enforcement with audited narrow exceptions for real runtime evidence and deliberately malformed test inputs. Keep safety comments; neither comments nor casts establish correctness.      |
| Exact optional properties                                             | Adopt as a compiler target after contract-aware migration. Absence and present-with-undefined are different contracts.                                                                                     |
| Unchecked indexed access                                              | Adopt as a compiler target after algorithm/data-model review. Do not repair diagnostics with blanket non-null assertions or invented defaults.                                                             |
| Adjacent array filter/map                                             | Disable the blanket ban. Prefer clear transformations; optimize measured or structurally important allocation/work without changing semantics.                                                             |
| Accumulator copying                                                   | Keep both copy rules. Growing repeated copies are a real complexity problem; fixed-size snapshots and observable intermediate versions can justify exceptions.                                             |
| `shape` substring naming ban                                          | Disable. Require meaningful domain names in review; a substring cannot establish domain ownership.                                                                                                         |
| Module mocking                                                        | Keep an error by default. Prefer real dependency seams; allow narrow exceptions for loader/runtime compatibility and failure-injection tests when injection would damage the thing being tested.           |
| Unknown returns/aliases, broad object parameters, unsafe dictionaries | Keep for internal contracts. Allow genuinely opaque or arbitrary-value boundaries without substituting fake schemas, aliases, or unconstrained generics.                                                   |
| Reflection and chained/widen-then assertions                          | Keep restrictions with concrete boundary exceptions. Do not replace reflection with an equally untyped descriptor lookup or change receiver/getter behavior solely to silence lint.                        |
| Readable spacing and test-import conventions                          | Keep as maintainability conventions, not safety guarantees.                                                                                                                                                |

For every exception, first strongly consider a cleaner, more correct refactor,
including breaking owned APIs and updating callers directly. Preserve actual
persisted-state, foreign API, and runtime requirements. Distinguish permanent
legitimate boundaries from temporary migration debt; do not add compatibility
wrappers solely to retain avoidable debt.

## What was measured

All probes were read-only with respect to application code and configuration.
Temporary configurations and modified rule copies were outside the repository.
Counts are diagnostics, not confirmed independent defects; multiple reports can
describe one flow, and repeated evaluation fixtures can duplicate reports.

| Probe                                                                | Result                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Native TypeScript 7.0.2 project baseline                             | 0 compiler diagnostics                                               |
| Same compiler file list with `exactOptionalPropertyTypes`            | 273 diagnostics                                                      |
| Same compiler file list with `noUncheckedIndexedAccess`              | 410 diagnostics                                                      |
| Five unsafe-flow rules added to the normal repository lint run       | 1,438 diagnostics: 168 TypeScript and 1,270 JavaScript               |
| TypeScript unsafe-flow split                                         | 31 outside tests/harnesses; 137 in tests/harnesses                   |
| `no-unsafe-type-assertion` added to normal lint                      | 42 diagnostics                                                       |
| Unknown-parameter/return rules over `pi/`, without package overrides | 88 diagnostics, all in `codex-provider`: 81 parameters and 7 returns |
| Same unknown probe after removing only the `cause` exemption         | 128 diagnostics: 40 additional named-cause cases                     |

The compiler comparisons used temporary configs extending the repository config
and a fixed file list from `tsc --showConfig`, excluding vendored rules as direct
roots. The baseline and changed configurations used the same roots; normal
transitive imports still applied. A separate null-assignment probe confirmed
strict null checking under the installed compiler's current defaults.

The unsafe-flow scan was:

```sh
vp lint \
  -D typescript/no-unsafe-assignment \
  -D typescript/no-unsafe-argument \
  -D typescript/no-unsafe-call \
  -D typescript/no-unsafe-member-access \
  -D typescript/no-unsafe-return --format json
```

The unknown probes used a temporary copy of the registered plugin, only the two
unknown rules, no package overrides, and existing inline exceptions. CLI `-D`
alone did not override the provider's configured exclusions, so that zero-result
run was not used as evidence that the provider was clean.

## Findings that change the policy

### Widening: fix the rule rather than naming the same structure

At the evaluated baseline, the rule rejected the first and accepted the second:

```ts
const user: { name: string } = { name: "Ada" };

type User = { name: string };
const user: User = { name: "Ada" };
```

It also rejects a finite mapped-key object while accepting the equivalent finite
`Record`. The `clankerusage` shared classifier correction removes these two
false positives. Reproduction probes confirmed that the correction still flags
the tested known-object-to-unknown and known-table-to-open-dictionary flows, and
still accepts a fresh empty dictionary accumulator.

There is an additional defect not fixed by that correction:

```ts
declare function isText(value: unknown): value is string;

function check(value: string | number) {
  return isText(value);
}
```

The baseline call-expression check reported this normal union discrimination as
loss of evidence. A predicate refining `number` into a branded positive-number
type is also reported. Passing a value to an unknown-accepting predicate does not
erase the caller's type; the predicate may validate a genuinely stronger runtime
invariant. Remove that unsupported check rather than banning reusable guards or
requiring one-use wrappers. Do not build a homegrown interprocedural type checker.

Preserve the branch's independent destructuring correction when porting the
classifier fix. Deliberately open mutable dictionaries and deliberate public API
abstractions still require contextual review; annotating them is not automatically
a defect, and constructing an empty object then assigning the same fields is not
a meaningful fix.

### Unsafe flow: higher-value enforcement, but not every finding is a bug

The five rules detect concrete escape routes missed by syntactic anti-slop rules:
untyped JSON, callback registries, generic SDK state, stream reads, and tool calls.
Examples include `ask-question/transcript.ts`, the shared extension test harness,
and `codex-provider/code-mode/renderers.ts`.

Assigning external `any` to `unknown` before decoding is allowed by the unsafe
assignment rule and is a real improvement. It prevents unchecked use without
pretending the data is already a domain object. A raw parse result may legitimately
be returned as unknown from an actual decoder stage; the unknown-return policy
must allow that narrow boundary rather than forcing a cast or a wrapper.

Some reports need different treatment. `ask-question/journal.ts` already collects
parsed values into `unknown[]` before validation, but its inline map callback
returns `any`. The generic schema parsing methods in `pi/tests/harness/agent-session.ts`
perform runtime parsing yet are reported for their library-level return typing.
Audit and repair the actual generic contract or document the proven boundary;
do not add duplicate validation solely to satisfy lint.

The JavaScript findings are concentrated in evaluation runtime/suite/verifier
code, including duplicated fixtures. Decide explicitly which code becomes typed
TypeScript or checked JavaScript. Do not mistake a TypeScript-only rollout for
repository-wide coverage, or make lint green by hiding unsafe operations behind
casts, JSDoc assertions, or newly untyped files.

Unsafe assertion enforcement adds independent value beyond safety comments, but
has legitimate exceptions: malformed-input tests, runtime-checked Pi internals,
and a serializer reparsing its own JSON. The 42 findings at the baseline were an audit
queue, not instructions to add 42 new predicates.

### Compiler flags: clarify contracts instead of manufacturing guards

Exact optional properties found both omission-sensitive DTOs and resettable
internal state. These are different fixes:

```ts
// A field absent from a request is different from a present undefined value.
const request = {
  endpoint,
  ...(timeout !== undefined ? { timeout } : {}),
};

// A state slot exists, but may not currently hold a controller.
let controller: AbortController | undefined;
```

For object/class state, model a required undefined-capable slot when that reflects
its actual lifecycle. Permit optional-plus-undefined only when both states are
part of the real contract. Do not append `| undefined` everywhere, delete real
state blindly, or create DTO builders merely to avoid conditional spread.

Unchecked access found command argument indexing, questionnaire traversal, and
geometry/test indexing. Prefer iteration over values when the index is incidental;
use tuples for fixed cardinality and model missing map entries explicitly. Some
mathematically bounded loops are beyond compiler inference; a local justified
assertion can be better than an impossible runtime error branch. Never default
missing data to empty strings or zero without domain justification.

Adopt both flags deliberately, with behavior tests. A useful target policy and a
staged migration are compatible; an unfinished migration is not completed coverage.
Make compiler strictness explicit rather than relying indefinitely on defaults.

### Array pipelines: linear work is not quadratic accumulation

Both ordinary `filter().map()` and fused alternatives are linear. Iterator helpers
can avoid an intermediate array, but do not by themselves establish a worthwhile
performance gain. No application performance benchmark was performed here.

Runtime probes confirmed observable differences:

- Eager filter/map ran `filter 1, filter 2, map 1, map 2`; the iterator rewrite ran
  `filter 1, map 1, filter 2, map 2`.
- `[, 1].filter(() => true).map(String)` returned `["1"]`; the iterator version
  returned `["undefined", "1"]`.
- Rewrites must also account for callback indexes, the array argument, `thisArg`,
  mutation during traversal, and when errors occur.

Use `flatMap` when it naturally models zero-or-more output; use lazy iteration
when streaming/short-circuiting or allocation matters; use loops when clearer.
Do not require iterator scaffolding or mutable reducers for every two-stage
transformation. Disable this blanket rule rather than collecting routine exceptions.

In contrast, repeatedly copying a growing accumulator can create quadratic work.
Keep that enforcement. `pi/tests/harness/extension-host.ts` demonstrates a real
exception: fresh fixed-size input-event snapshots preserve earlier events held
by handlers. In-place mutation would change behavior, and fixed-size copying is
not the growing-accumulator case. Refactor only after establishing ownership and
whether intermediate versions are observable.

### Naming and mocking: distinguish ownership from spelling

The naming rule bans the substring `shape` in symbols, not ambiguous concepts.
A probe using the legitimate geometric type `Shape` fails; renaming the identical
contract to `Form` passes. The repository already needs a geometric-package
override. Retire the substring ban; keep domain naming as a review standard.

Module mocking has more architectural signal. Tests replacing controller/process
constructors indicate useful dependency seams, for example the direct tool process
manager and usage controller. Prefer existing contract types or a small injected
function/factory, not a new service layer and mirrored interface for every import.

Do not classify every mock as migration debt. The editor degradation test forces
the private compatibility adapter to fail while testing the public fallback path.
Tests of module loading, third-party compatibility, and otherwise inaccessible
failure paths can justify a narrowly explained module mock. Refactoring remains
the first consideration, but injection must not bypass the behavior under test.
Replace blanket file overrides with specific decisions, including legitimate
exceptions where appropriate; merely changing `vi.mock` to `vi.spyOn` is not an
architectural improvement.

## Accepted implementation sequence (historical)

1. Apply low-risk configuration decisions: conditional spread, array pipeline,
   and naming bans; record their rationale, not just `off` settings.
2. Correct widening classification and predicate-call behavior with regression
   tests. Remove the unknown rule's name exemption with boundary-specific review.
3. Remediate and enable TypeScript unsafe-flow rules and unsafe assertions. Review
   test-harness generic/SDK contracts before changing all their consumers.
4. Migrate exact optional properties and indexed access by owned contract, not
   by diagnostic spelling. Include runtime behavior and malformed-input tests.
5. Replace provider-wide unknown exclusions and mocking file overrides with
   typed seams or narrow documented exceptions. Decide evaluation-JavaScript
   typing/coverage explicitly and track any remaining exclusions as debt.

Do not require stages to wait when a cleaner contract solves several issues at
once. Do not turn on failing rules and conceal the backlog behind a new permanent
package exclusion. The policy can be settled before every migration is finished.

## Primary sources

- [TypeScript: satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator): check a contract without replacing useful inferred type information.
- [TypeScript: exact optional properties](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html): property absence is not a present undefined value.
- [TypeScript: unchecked indexed access](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html): account for missing indexed properties.
- [typescript-eslint: unsafe assignment](https://typescript-eslint.io/rules/no-unsafe-assignment/) and [unsafe return](https://typescript-eslint.io/rules/no-unsafe-return/): protect against `any` flow while permitting safe unknown boundaries; document limitations and rollout considerations.
- [typescript-eslint: unsafe type assertion](https://typescript-eslint.io/rules/no-unsafe-type-assertion/): distinguish narrowing assertions from safe widening; acknowledge test-stub costs.
- [MDN: filter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter) and [iterator map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Iterator/map): eager array callbacks, sparse slots, and lazy iteration semantics.
- [Biome: accumulating spread](https://biomejs.dev/linter/rules/no-accumulating-spread/): repeated growing copies can produce quadratic work.
- [MDN: conditional object spread](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Spread_syntax#conditionally_adding_properties_to_an_object) and [Unicorn: conditional spread consistency](https://github.com/sindresorhus/eslint-plugin-unicorn/blob/main/docs/rules/consistent-conditional-object-spread.md): omission-preserving construction and a configurable style choice, not a safety ban.
- [Vitest: module mocking](https://vitest.dev/guide/mocking/modules#mocking-pitfalls): actual mocking limitations and dependency-injection guidance, not a universal prohibition on mocks.
- [typescript-eslint: naming conventions](https://typescript-eslint.io/rules/naming-convention/): configurable conventions communicate intent; naming enforcement is stylistic, not a proof of ownership.

Local evidence: vendored rule implementations in `tools/oxlint/anti-slop/`, their
regression tests, current repository call sites, and the classifier correction in
the sibling `clankerusage` project. No private transcripts were copied into this
evaluation.
