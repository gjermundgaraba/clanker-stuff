# Lint policy

Keep enforcement strict where it protects contracts, ownership, correctness, or meaningful performance guarantees. A passing lint run is not itself evidence of type safety. `vp check` runs Oxlint and Oxfmt with Ultracite's core, anti-slop and Vitest presets and `@effect/tsgo`'s recommended preset. Oxlint takes them, with the exceptions every one of the maintainer's repositories shares, from [`@clanker-stuff/oxlint-config`](../packages/oxlint-config/README.md); `oxlint.config.ts` adds the overrides that name this repository's files, and [Repository overrides](#repository-overrides) gives the reason for each.

## Refactor before making an exception

This applies to every lint exception, not only the boundary rules below, and to existing exceptions when the affected code is changed.

1. Identify the actual invariant and the producer/consumer that owns it. Check whether the diagnostic exposes a missing boundary, erased type information, duplicate validation, or an unnecessary abstraction.
2. Strongly consider a cleaner, more correct refactor that removes the need for the exception, even if it breaks an owned API. Move decoding to the real boundary, preserve producer types, delete redundant checks, or change the contract and update all affected callers and tests. Do not add compatibility wrappers solely to preserve the old design. API stability alone is not a reason to keep avoidable debt.
3. Preserve concrete safety requirements: actual persisted sessions, third-party contracts, malformed external input, and runtime compatibility are not erased by permission to break owned APIs. Establish migration or failure behavior before changing these boundaries.
4. If a rule rejects correct code, prefer a tested rule correction when feasible. Otherwise use the smallest justified exception. State the concrete boundary or invariant and why the operation is still necessary, not just "lint noise" or "legacy". Propose it as a file-scoped override in `oxlint.config.ts` and record its reason under [Repository overrides](#repository-overrides); do not add inline disable comments. The disables that predate Ultracite stay where they are.
5. Test the retained behavior or the refactor. Unused disable directives remain errors. Temporary debt must describe what contract work would remove it; legitimate policy exceptions need not promise a pointless future rewrite.

Do not make lint pass by renaming a parameter to an exempt name, removing its annotation, substituting `any`, inventing an unconstrained generic, casting a value, or moving the same check into a one-use helper. A primitive schema that merely substitutes for `typeof` is not additional validation. Neither a comment nor a predicate signature proves its claimed invariant.

## Unknown inputs

Internal operations should accept concrete owner/schema-derived contracts. Unknown input belongs at real decoding, exception, serializer, or third-party adapter boundaries. Prefer parsing once and passing typed values downstream to repeated field probing. The shared preset disables `no-unknown-parameters` and `no-unknown-returns`: decoding, exceptions, serializers, and third-party adapters may accept `unknown` without a suppression. Those parameters are decoders and validators (`parseConfig`, `validateQuestionnaire`), error describers, serializers and JSON replacers, `.catch` handlers, and Pi's untyped event payloads; the rule cannot tell such a boundary from a consumer that skipped one. Do not create wrappers or erase owner types to satisfy a syntactic convention; review whether each boundary actually needs arbitrary input. Parameter names such as `cause`, `error`, and `value` do not change that responsibility.

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
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Keep opaque values unknown until their actual consumer can decode them. An arbitrary-value serializer or foreign protocol adapter may legitimately return unknown; explain that specific return boundary. Do not replace it with `any`, a fake domain name, a schema that establishes no new invariant, or a cast.

## Runtime typeof

`no-runtime-typeof` runs with `allowInTypeGuards: true`: a type predicate whose body checks what it claims may use `typeof`. Files where `typeof` tells apart the members of a declared union, or is the hand-written decoder at the boundary, are listed in `oxlint.config.ts`.

- Keep owner-derived types inside the application and decode external data at its actual boundary. Do not scatter partial interpretations of the same input.
- Use direct discrimination for typed unions, diagnostics, and private runtime adapters when it expresses the required check clearly.
- Use complete schemas or handwritten validation where an external contract requires them. A primitive type check alone does not validate that contract.
- Preserve finite-number constraints, omitted-property semantics, and independent diagnostics when changing an existing validator.

```ts
// This discriminates an already-valid union; it does not validate raw JSON.
const count = typeof limit === "number" ? limit : rows.length;
```

## Type safety and inference

Type-aware unsafe assignment, argument, call, member-access, return, and narrowing assertion rules are errors. Quarantine foreign `any` as `unknown` before decoding; do not let SDK generic defaults propagate unchecked values through internal APIs.

```ts
// Not a domain contract: const user = JSON.parse(text) as User;
const raw: unknown = JSON.parse(text);
const user = Value.Parse(UserSchema, raw);
```

Use producer/schema-derived types. Preserve useful inferred keys with `satisfies` where appropriate. Precise inline objects and finite mapped keys do not require single-use named aliases. Passing a typed value to a predicate does not erase its type: union narrowing and stronger domain refinements are legitimate operations. Deliberate abstraction behind an owned API can also justify reducing exposed detail; do not create empty objects and add properties afterward to evade widening checks.

Assertions require actual evidence, not just a `SAFETY` comment. Prefer compiler proof or real runtime validation. Keep a narrow, explained exception for evidence the compiler cannot represent, such as a runtime-checked foreign interface or a deliberately malformed test fixture. A pinned SDK declaration conflict may also need a narrow `@ts-expect-error`: explain the precise mismatch, preserve the actual runtime contract, and cover it with tests. Do not normalize valid data or replace a real stream just to work around inaccurate foreign optional-property declarations. Do not replace an assertion with a lying predicate, duplicate validation, or a one-use wrapper.

The reason on a `typescript/no-unsafe-type-assertion` suppression is that assertion's safety justification; do not repeat it in a separate `SAFETY:` comment.

## Optional properties and indexed access

`strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are enabled. An omitted property is not the same as a present property containing undefined. Construct DTOs with the intended omission semantics:

```ts
const options = {
  endpoint,
  ...(timeout !== undefined ? { timeout } : {}),
} satisfies RequestOptions;
```

Resettable internal state should use undefined-capable slots where that describes its lifecycle. Do not mechanically append `| undefined` to optional contracts, delete properties blindly, or introduce mutable DTO builders to satisfy lint. Allow present-with-undefined only when the actual contract permits it.

For indexed access, prefer value iteration when indexes are incidental, tuples when cardinality is fixed, and explicit missing-entry handling when absence is possible. Do not invent default values or impossible runtime failure branches. A local explained assertion is appropriate when a concrete bound or ownership invariant exists but the compiler cannot express it; blanket non-null assertions are not a migration strategy.

## Construction, collections, and naming

The conditional-empty-object-spread ban is disabled. The `shape` substring ban is disabled only for Shape Spinner, its glyph package, and the one subagents file that uses its published command, where shapes are the domain. The adjacent filter/map ban is enforced.

- Keep optional fields in their construction when clearest. Use separate branches when they reveal real domain variants or simplify complex control flow.
- Fuse adjacent filter/map passes with `flatMap` or iterator helpers (`.values().filter(…).map(…).toArray()`). Iterator helpers interleave the callbacks per element and visit holes as `undefined`, so preserve sparse-array behavior, callback order/indexes/arguments, receiver semantics, mutation behavior, and error timing when rewriting.
- Keep accumulator-copy enforcement: repeated growing copies can be quadratic. Mutate only fresh locally owned accumulators. Independent fixed-size snapshots or observable intermediate versions may justify copying; do not destroy those semantics just to satisfy a performance heuristic.
- Choose meaningful domain names. A geometric `Shape` is valid; a substring is not evidence of either ambiguity or ownership.

Readable spacing and import conventions remain maintainability rules. Label style as style, not proof of correctness or performance.

## Dependency seams, reflection, and tests

Module mocking remains restricted: `vitest/no-restricted-vi-methods` rejects `vi.mock` and `vi.doMock` in tests. Prefer real dependencies and small injected functions/factories using existing contracts. Do not invent a service hierarchy, mirror interface, or public configuration switch for every mocked import. Consider deleting mock-only tests when real tests already prove the behavior.

Loader, runtime-compatibility, and otherwise inaccessible failure-path tests may need a narrow module-mocking exception. Injection must not bypass the behavior under test. Classify these legitimate cases separately from avoidable coupling; changing `vi.mock` to `vi.spyOn` is not an architectural refactor.

Keep reflection and chained/widen-then assertion restrictions. Prefer typed calls and property access, but preserve real getter, receiver, proxy, and foreign-runtime semantics. Replacing reflection with an untyped descriptor lookup is not added type safety.

The same policy covers tests, harnesses, scripts, and maintained JavaScript. Foreign code, generated artifacts, and intentionally malformed fixtures require explicit boundary treatment, not accidental gaps in coverage. Never move code to an untyped file to escape enforcement. Preserve real persisted state and external contracts during clean-break refactors; remove compatibility machinery only for interfaces actually being retired.

The [evaluation record](lint-policy-evaluation.md) explains the evidence behind these decisions. It is historical rationale, not a second policy or permission to leave its original migration backlog excluded from enforcement.

## Evaluation tooling and deployed modules

Maintained evaluation JavaScript is checked with `allowJs` and `checkJs`; JSDoc uses the actual owner types, not parallel interfaces. `tsconfig.json` maps the container's absolute module paths to their checked-in sources. Its `rootDirs` models directories merged by the evaluation image/task generators. These are compile-time resolution settings, not runtime aliases or compatibility shims. Update the generators and their tests whenever the deployed layout changes.

Keep deliberately defective benchmark starting code defective. An exception must identify the specific task defect being preserved; the reference solution and verifier remain checked normally. Malformed external evidence should invalidate its relevant contract, not crash a grader or erase independent task metrics. Dynamic-loader assertions are appropriate only for exact owned/generated modules or pinned dependencies, not arbitrary user JSON or unvalidated tool results.

## Repository overrides

The overrides `oxlint.config.ts` passes to the shared preset, and why each exists:

- **Ignored paths.** `**/.harbor/**` holds evaluation caches and raw runs, which contain third-party source; Vitest excludes it too. An eval task's `environment/` is the starting workspace the agent under test is asked to fix. Its defects are the task and graders pin its bytes by hash, so lint and format must never touch it. `skills/skill-doctor/**` is an adapted third-party skill with a minified diff bundle, kept as upstream wrote it for syncs. Oxfmt also skips `AGENTS.md`, because `vp config` rewrites its Vite+ block on every install.
- **`typescript/method-signature-style` off for the editor and skill-providers entry points.** They publish interfaces that implementers satisfy; property signatures would check those methods' parameters contravariantly and reject existing implementations.
- **`import/no-absolute-path` off for the eval container modules.** The container mounts them at `/opt/pi-evals`, `/tests`, `/solution` and `/app`; `tsconfig.json` paths map the same addresses for type checking.
- **`vitest/*` off for `pi/evals/**/*.test.{js,mjs}`.** Eval tests and graders run on `node:test` inside the eval container, not on Vitest.
- **`unicorn/prefer-code-point` off for Shape Spinner's `geometry.ts`.** `fnv1aUtf16Units` hashes UTF-16 code units to seed the committed glyph fixtures; hashing code points would change those fixtures for astral input.
- **`unicorn/prefer-code-point` off for tool-rendering's `text.ts`.** A JSON `\uXXXX` escape encodes one UTF-16 code unit, so `charCodeAt` is the right call.
- **`unicorn/prefer-dom-node-remove` off for the subagents transcript.** pi-tui's `Container.removeChild` is not a DOM node method.
- **`class-methods-use-this` with `ignoreClassesWithImplements`.** These classes implement Pi's `Component` or the runtime interface their fakes stand in for, so a method stays an instance method even when it ignores `this`.
- **`node/callback-return` off for three files.** Their `next` is a domain function, the vim document's next cell or Pi's renderer chain, not a Node callback, so `return next(...)` would be wrong.
- **`no-unmodified-loop-condition` off for claude-bridge's prompt stream.** The loop condition reads `done` and `failure`, which `end()` and `fail()` set while the loop awaits.
- **`unicorn/prefer-spread` off for turn-recap's conversation and its runtime test.** They count code points: `Array.from(text)` trips `prefer-spread`, and `[...text]` trips `typescript/no-misused-spread`.
- **`unicorn/prefer-single-call` off for three test files.** Their fakes' `push` takes one message by contract (the SDK query, the watch decoder); the rule reads them as `Array#push`.
- **`unicorn/prefer-structured-clone` off for the background-tasks renderer test.** The JSON round trip is the point: the expectation is what the tool's JSON text or a reloaded session holds, which drops `undefined` fields that `structuredClone` keeps.
- **`vitest/valid-expect` off for claude-bridge's prompt-stream test.** A rejection assertion is attached before the action that rejects and awaited after it, which the rule cannot express: awaiting it at once hangs, and a bare promise rejects unhandled.
- **`vitest/no-standalone-expect` off for two test files.** Their assertions sit outside a test body on purpose: a `beforeEach` precondition that should fail every test, and a fake runtime's `settle()` and `finish()`, which poll with `vi.waitFor`.
- **`prefer-const` with `ignoreReadBeforeAssign` for the subagents runtime integration test.** Callbacks registered before the runtime exists read `steer`, which is destructured from the runtime afterwards.
- **`anti-slop/no-shape-in-symbol-names` off for Shape Spinner and its glyph package.** "Shape" names that domain and the product: the glyph package, its persisted settings and the published `SHAPE_SPINNER_COMMAND`.
- **`anti-slop/no-runtime-typeof` off for the listed files.** There `typeof` either tells apart the members of a declared union (Pi's `string | Content[]`, `JsonValue`, `string | Settings`, `OverlayOptions | (() => OverlayOptions)`), where nothing is left to parse, or is the hand-written decoder at the boundary (configs, JSON, logs, CDP results, and the eval scripts, whose type predicates are JSDoc the rule cannot see).
- **`typescript/no-unsafe-type-assertion` off for the TUI test harness.** Pi exports `KeybindingsManager` only as a type, so `createKeybindings` casts a double that implements the keyboard contract components consume.
- **`no-console` limited to `error` and `warn` outside scripts, tests and evals.** Stricter than the presets: stdout is Pi's JSON and RPC transport, so extension code must not write to it.
