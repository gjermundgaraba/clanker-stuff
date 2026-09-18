# Lint policy

Keep enforcement strict where it protects contracts, ownership, correctness, or
meaningful performance guarantees. A passing lint run is not itself evidence of
type safety. `vite.config.ts` owns configuration; vendored rule changes and their
provenance live in `tools/oxlint/anti-slop/UPSTREAM.md`.

## Refactor before making an exception

This applies to every lint exception, not only the boundary rules below, and to
existing exceptions when the affected code is changed.

1. Identify the actual invariant and the producer/consumer that owns it. Check
   whether the diagnostic exposes a missing boundary, erased type information,
   duplicate validation, or an unnecessary abstraction.
2. Strongly consider a cleaner, more correct refactor that removes the need for
   the exception, even if it breaks an owned API. Move decoding to the real
   boundary, preserve producer types, delete redundant checks, or change the
   contract and update all affected callers and tests. Do not add compatibility
   wrappers solely to preserve the old design. API stability alone is not a
   reason to keep avoidable debt.
3. Preserve concrete safety requirements: actual persisted sessions, third-party
   contracts, malformed external input, and runtime compatibility are not erased
   by permission to break owned APIs. Establish migration or failure behavior
   before changing these boundaries.
4. If a rule rejects correct code, prefer a tested rule correction when feasible.
   Otherwise use the smallest justified exception. State the concrete boundary
   or invariant and why the operation is still necessary, not just "lint noise"
   or "legacy". Use a line-level disable or a tightly bounded disable/enable pair
   for a single coherent operation; avoid file/package-wide exclusions.
5. Test the retained behavior or the refactor. Unused disable directives remain
   errors. Temporary debt must describe what contract work would remove it;
   legitimate policy exceptions need not promise a pointless future rewrite.

Do not make lint pass by renaming a parameter to an exempt name, removing its
annotation, substituting `any`, inventing an unconstrained generic, casting a
value, or moving the same check into a one-use helper. A primitive schema that
merely substitutes for `typeof` is not additional validation. Neither a comment
nor a predicate signature proves its claimed invariant.

## Unknown inputs

Internal operations should accept concrete owner/schema-derived contracts.
Unknown input belongs at real decoding, exception, serializer, or third-party
adapter boundaries. Prefer parsing once and passing typed values downstream to
repeated field probing. A genuine boundary may need a narrow exception; do not
create a wrapper merely to relocate the unknown parameter. Parameter names do
not grant exceptions: `cause`, `error`, and `value` follow the same policy.

For example, when `Invoice` is already the validated owner contract:

```ts
// Avoid: each internal consumer reinterprets the same untyped value.
function invoiceLabel(input: unknown) {
  return Value.Parse(InvoiceSchema, input).id;
}

// Prefer: decode at the real input boundary; keep internal consumers typed.
const invoice = Value.Parse(InvoiceSchema, raw);
function invoiceLabel(input: Invoice) {
  return input.id;
}
```

Do not extend that refactor to arbitrary thrown values: those really are unknown.

```ts
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript may throw any value.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Keep opaque values unknown until their actual consumer can decode them. An
arbitrary-value serializer or foreign protocol adapter may legitimately return
unknown; explain that specific return boundary. Do not replace it with `any`, a
fake domain name, a schema that establishes no new invariant, or a cast.

## Runtime typeof

`no-runtime-typeof` is enabled with `allowInTypeGuards: true`. The rule recognizes
explicit TypeScript predicate/assertion signatures, not validation correctness or
the operand's type. JSDoc predicates in maintained JavaScript currently need a
narrow exception explaining their actual validation boundary. Comparisons against `"undefined"` are already exempt.

- Refactor scattered interpretation of external domain data into its actual
  decoder. Use existing schemas or complete handwritten validation; do not
  introduce a second interpretation path.
- Allow genuine handwritten predicates/assertions through the supported option.
  Do not introduce trivial `isString`/`isNumber` wrappers just for that exemption.
- Keep direct discrimination of an already-typed union when it expresses the
  operation correctly. A narrow exception is preferable to a wrapper, primitive
  schema, or new tagged-object API with no domain benefit.
- Arbitrary-value serializers and diagnostics must handle values outside any
  domain schema. Explain that responsibility in a narrow exception.
- Runtime/version adapters and tests may need to inspect values independently of
  static declarations. Keep only checks that protect a concrete runtime failure
  or verify an actual boundary contract.

For example, `typeof limit === "number"` on `number | "unlimited"` discriminates
the declared contract; it does not indicate unparsed input. Conversely, checking
one field on raw account JSON in every consumer suggests a missing account
decoder. Review the data flow before choosing a refactor or an exception.

```ts
// Avoid: a primitive schema or one-use isNumber wrapper adds no invariant here.
const count = Value.Check(Type.Number(), limit) ? limit : rows.length;

// Prefer: direct discrimination of the declared number | "unlimited" contract.
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- A numeric limit and "unlimited" are already-typed alternatives, not raw external data.
const count = typeof limit === "number" ? limit : rows.length;
```

This example assumes an already-valid limit; neither version validates a raw
positive-integer limit. Validate that stronger contract at its real boundary.

Changes between `typeof value === "number"` and schema validation must preserve
finite-number constraints where required. Do not accidentally admit `NaN` or
infinities, change omitted-property semantics, or hide independently useful
diagnostics through stricter whole-object validation.

## Type safety and inference

Type-aware unsafe assignment, argument, call, member-access, return, and narrowing
assertion rules are errors. Quarantine foreign `any` as `unknown` before decoding;
do not let SDK generic defaults propagate unchecked values through internal APIs.

```ts
// Not a domain contract: const user = JSON.parse(text) as User;
const raw: unknown = JSON.parse(text);
const user = Value.Parse(UserSchema, raw);
```

Use producer/schema-derived types. Preserve useful inferred keys with `satisfies`
where appropriate. Precise inline objects and finite mapped keys do not require
single-use named aliases. Passing a typed value to a predicate does not erase its
type: union narrowing and stronger domain refinements are legitimate operations.
Deliberate abstraction behind an owned API can also justify reducing exposed
detail; do not create empty objects and add properties afterward to evade widening
checks.

Assertions require actual evidence, not just a `SAFETY` comment. Prefer compiler
proof or real runtime validation. Keep a narrow, explained exception for evidence
the compiler cannot represent, such as a runtime-checked foreign interface or a
deliberately malformed test fixture. A pinned SDK declaration conflict may also
need a narrow `@ts-expect-error`: explain the precise mismatch, preserve the actual
runtime contract, and cover it with tests. Do not normalize valid data or replace a
real stream just to work around inaccurate foreign optional-property declarations.
Do not replace an assertion with a lying predicate, duplicate validation, or a
one-use wrapper.

## Optional properties and indexed access

`strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are enabled.
An omitted property is not the same as a present property containing undefined.
Construct DTOs with the intended omission semantics:

```ts
const options = {
  endpoint,
  ...(timeout !== undefined ? { timeout } : {}),
} satisfies RequestOptions;
```

Resettable internal state should use undefined-capable slots where that describes
its lifecycle. Do not mechanically append `| undefined` to optional contracts,
delete properties blindly, or introduce mutable DTO builders to satisfy lint.
Allow present-with-undefined only when the actual contract permits it.

For indexed access, prefer value iteration when indexes are incidental, tuples
when cardinality is fixed, and explicit missing-entry handling when absence is
possible. Do not invent default values or impossible runtime failure branches.
A local explained assertion is appropriate when a concrete bound or ownership
invariant exists but the compiler cannot express it; blanket non-null assertions
are not a migration strategy.

## Construction, collections, and naming

The conditional-empty-object-spread, adjacent filter/map, and `shape` substring
bans are disabled. They do not establish the guarantees their restrictions imply.

- Keep optional fields in their construction when clearest. Use separate branches
  when they reveal real domain variants or simplify complex control flow.
- Allow ordinary filter/map pipelines. Use `flatMap`, lazy iteration, or loops
  when they naturally express the operation or address important work/allocation.
  Preserve sparse-array behavior, callback order/indexes/arguments, receiver
  semantics, mutation behavior, and error timing when rewriting.
- Keep accumulator-copy enforcement: repeated growing copies can be quadratic.
  Mutate only fresh locally owned accumulators. Independent fixed-size snapshots
  or observable intermediate versions may justify copying; do not destroy those
  semantics just to satisfy a performance heuristic.
- Choose meaningful domain names. A geometric `Shape` is valid; a substring is
  not evidence of either ambiguity or ownership.

Readable spacing and import conventions remain maintainability rules. Label style
as style, not proof of correctness or performance.

## Dependency seams, reflection, and tests

Module mocking remains restricted. Prefer real dependencies and small injected
functions/factories using existing contracts. Do not invent a service hierarchy,
mirror interface, or public configuration switch for every mocked import. Consider
deleting mock-only tests when real tests already prove the behavior.

Loader, runtime-compatibility, and otherwise inaccessible failure-path tests may
need a narrow module-mocking exception. Injection must not bypass the behavior
under test. Classify these legitimate cases separately from avoidable coupling;
changing `vi.mock` to `vi.spyOn` is not an architectural refactor.

Keep reflection and chained/widen-then assertion restrictions. Prefer typed calls
and property access, but preserve real getter, receiver, proxy, and foreign-runtime
semantics. Replacing reflection with an untyped descriptor lookup is not added
type safety.

The same policy covers tests, harnesses, scripts, and maintained JavaScript.
Foreign code, generated artifacts, and intentionally malformed fixtures require
explicit boundary treatment, not accidental gaps in coverage. Never move code to
an untyped file to escape enforcement. Preserve real persisted state and external
contracts during clean-break refactors; remove compatibility machinery only for
interfaces actually being retired.

The [evaluation record](lint-policy-evaluation.md) explains the evidence behind
these decisions. It is historical rationale, not a second policy or permission
to leave its original migration backlog excluded from enforcement.

## Evaluation tooling and deployed modules

Maintained evaluation JavaScript is checked with `allowJs` and `checkJs`; JSDoc
uses the actual owner types, not parallel interfaces. `tsconfig.json` maps the
container's absolute module paths to their checked-in sources. Its `rootDirs`
models directories merged by the evaluation image/task generators. These are
compile-time resolution settings, not runtime aliases or compatibility shims.
Update the generators and their tests whenever the deployed layout changes.

Keep deliberately defective benchmark starting code defective. An exception must
identify the specific task defect being preserved; the reference solution and
verifier remain checked normally. Malformed external evidence should invalidate
its relevant contract, not crash a grader or erase independent task metrics.
Dynamic-loader assertions are appropriate only for exact owned/generated modules
or pinned dependencies, not arbitrary user JSON or unvalidated tool results.
