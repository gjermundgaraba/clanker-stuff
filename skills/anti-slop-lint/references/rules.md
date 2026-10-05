# Rule-family guidance

How to resolve findings from each anti-slop rule family and its type-aware companions. Every entry assumes [exceptions.md](exceptions.md) has been applied first: refactor at the boundary, then narrow exception, never laundering.

## Unknown inputs

Rules: `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`, `no-object-parameters`, `no-unsafe-dictionary-type`.

Internal operations accept concrete owner- or schema-derived contracts. Unknown belongs at real decoding, exception, serializer, or third-party adapter boundaries. Parse once at the boundary and pass typed values downstream instead of probing fields in every consumer. Parameter names do not grant exceptions: `cause`, `error`, and `value` follow the same policy.

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

Do not extend that refactor to arbitrary thrown values. Those really are unknown:

```ts
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript may throw any value.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Keep opaque values unknown until their actual consumer can decode them. A raw parse result may be returned as unknown from an actual decoder stage; explain that return boundary rather than casting, aliasing to a fake domain name, or introducing a schema that establishes nothing new. Do not create a wrapper merely to relocate the unknown parameter.

## Runtime typeof

Rule: `no-runtime-typeof`, typically configured `["error", { allowInTypeGuards: true }]`.

The rule is syntactic. It recognizes explicit TypeScript predicate and assertion signatures, not validation correctness or the operand's type. Comparisons against `"undefined"` are exempt. JSDoc predicates in maintained JavaScript need a narrow exception naming their validation boundary.

- **Scattered interpretation of external data** points to a missing decoder. Move it there; use existing schemas or complete handwritten validation. Do not introduce a second interpretation path.
- **Genuine handwritten predicates and assertions** pass through the option. Do not add trivial `isString`/`isNumber` wrappers to claim the exemption.
- **Direct discrimination of an already-typed union** is correct code. Take a narrow exception rather than a wrapper, a primitive schema, or a new tagged-object API with no domain benefit.
- **Arbitrary-value serializers and diagnostics** must handle values outside any schema. Explain that responsibility in a narrow exception.
- **Runtime and version adapters, and some tests,** inspect values independently of static declarations. Keep only checks that protect a concrete runtime failure or verify an actual boundary contract.

```ts
// Avoid: a primitive schema or one-use isNumber wrapper adds no invariant here.
const count = Value.Check(Type.Number(), limit) ? limit : rows.length;

// Prefer: direct discrimination of the declared number | "unlimited" contract.
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- A numeric limit and "unlimited" are already-typed alternatives, not raw external data.
const count = typeof limit === "number" ? limit : rows.length;
```

Conversely, checking one field on raw account JSON in every consumer means the account decoder is missing. Review the data flow before choosing.

When moving between `typeof value === "number"` and schema validation, preserve finite-number constraints. Do not admit `NaN` or infinities, change omitted-property semantics, or hide independently useful diagnostics behind whole-object validation.

## Type safety, widening, and assertions

Rules: `no-known-value-widening`, `no-widen-then-assert`, `no-chained-type-assertions`, `require-safety-comment-for-type-assertion`, and the type-aware `typescript/no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return`, `no-unsafe-type-assertion`.

Quarantine foreign `any` as `unknown` before decoding. Do not let SDK generic defaults propagate unchecked values through internal APIs.

```ts
// Not a domain contract:
const user = JSON.parse(text) as User;

// Prefer:
const raw: unknown = JSON.parse(text);
const user = Value.Parse(UserSchema, raw);
```

Use producer- or schema-derived types. Preserve useful inferred keys with `satisfies`. Precise inline objects and finite mapped keys do not need single-use named aliases. Passing a typed value to a predicate does not erase its type: union narrowing and stronger domain refinements are legitimate. Deliberate abstraction behind an owned API may justify reducing exposed detail; constructing an empty object and assigning properties afterward to dodge the widening rule does not.

Assertions need actual evidence, not just a `SAFETY` comment. Prefer compiler proof or real runtime validation. Keep a narrow explained exception for evidence the compiler cannot represent: a runtime-checked foreign interface, a deliberately malformed test fixture, a pinned dependency resolved from a deployed path. A pinned SDK declaration conflict may need a narrow `@ts-expect-error` that states the precise mismatch, preserves the runtime contract, and is covered by tests. Do not replace an assertion with a lying predicate, duplicate validation, or a one-use wrapper.

## Optional properties and indexed access

Compiler flags: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Related rule: `no-conditional-empty-object-spread` when enabled.

An omitted property is not the same as a present property containing `undefined`. Construct DTOs with the intended omission semantics:

```ts
const options = {
  endpoint,
  ...(timeout !== undefined ? { timeout } : {}),
} satisfies RequestOptions;
```

Resettable internal state uses an undefined-capable slot when that describes its lifecycle:

```ts
let controller: AbortController | undefined;
```

Do not mechanically append `| undefined` to optional contracts, delete properties blindly, or introduce mutable DTO builders to satisfy lint. Allow present-with-undefined only when the actual contract permits it.

For indexed access, prefer iterating values when the index is incidental, tuples when cardinality is fixed, and explicit missing-entry handling when absence is possible. Do not invent default values such as empty strings or zero, or impossible runtime failure branches. A local explained assertion is appropriate when a concrete bound or ownership invariant exists that the compiler cannot express; blanket non-null assertions are not a migration strategy.

## Construction, collections, and naming

Rules: `no-array-filter-map`, `no-reduce-accumulator-copy`, `oxc/no-accumulating-spread`, `no-conditional-empty-object-spread`, `no-shape-in-symbol-names`, `require-readable-spacing`.

- **Filter/map pipelines.** Both eager `filter().map()` and fused alternatives are linear. When the rule is enabled and a rewrite is required, use `flatMap` only when it naturally models zero-or-more output, lazy `.values().filter().map().toArray()` only when the runtime supports iterator helpers and streaming or allocation matters, and loops when clearer. Rewrites change observable behavior: eager runs all filters before any map, lazy interleaves them; sparse arrays differ; callback index and array arguments, `thisArg`, mutation during traversal, and error timing all differ. Preserve them or do not rewrite.
- **Accumulator copies.** Repeated growing copies are quadratic. Mutate only fresh, locally owned accumulators. Independent fixed-size snapshots or observable intermediate versions can justify copying; do not destroy those semantics for a heuristic. Refactor only after establishing ownership and observability.
- **Conditional spread.** Keep optional fields in their construction when clearest. Separate branches only when they reveal real domain variants or simplify control flow.
- **Naming.** Choose meaningful domain names. A geometric `Shape` is valid; a substring proves neither ambiguity nor ownership.
- **Spacing and imports** are maintainability conventions. Label style as style, not proof of correctness or performance.

## Dependency seams, reflection, and tests

Rules: `no-module-mocking`, `no-reflect-apply`, `no-reflect-get`.

Prefer real dependencies and small injected functions or factories using existing contracts. Do not invent a service hierarchy, mirror interface, or public configuration switch for every mocked import. Consider deleting mock-only tests when real tests already prove the behavior.

Loader, runtime-compatibility, and otherwise inaccessible failure-path tests may need a narrow module-mocking exception. Injection must not bypass the behavior under test; forcing a private adapter to fail while testing the public fallback is a legitimate mock. Classify these separately from avoidable coupling. Changing `vi.mock` to `vi.spyOn` is not an architectural refactor.

Note the rule matches the test framework import it knows about. If the repository imports `vi` from another entry point, the rule may never fire; that is a vendored-rule correction with a regression test, recorded in `UPSTREAM.md`.

For reflection, prefer typed calls and property access, but preserve real getter, receiver, proxy, and foreign-runtime semantics. Replacing `Reflect.get` with an equally untyped descriptor lookup is not added type safety.

## Scope of enforcement

The same policy covers tests, harnesses, scripts, and maintained JavaScript checked with `allowJs`/`checkJs`. JSDoc uses the actual owner types, not parallel interfaces. Foreign code, generated artifacts, and intentionally malformed fixtures need explicit boundary treatment via `ignorePatterns` or explained exceptions, not accidental gaps. Never move code to an untyped file to escape enforcement.

Deliberately defective code, such as a benchmark's starting state, stays defective; the exception names the specific defect being preserved, and the reference solution and verifier are checked normally.
