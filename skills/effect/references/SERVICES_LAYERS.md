# Services, Layers, And Modules

## Contents

- [Module Surface](#module-surface)
- [Layer Constructors](#layer-constructors)
- [Long-Lived Work](#long-lived-work)
- [Runtime Wiring](#runtime-wiring)
- [Effect.fn](#effectfn)
- [Operation Error Helpers](#operation-error-helpers)
- [Nested Reason Errors](#nested-reason-errors)

Use this when defining service tags, module surfaces, layer implementations, runtime wiring, typed errors, or `Effect.fn` operation boundaries.

For whether a service or provisioning boundary should exist and which module owns it, read [`SERVICE_DESIGN.md`](SERVICE_DESIGN.md). This reference owns implementation mechanics.

## Module Surface

Follow the repository's established service naming and export conventions. Export only intentional surface; keep local schemas, row codecs, helpers, and implementation details private. Do not introduce TypeScript `namespace` declarations for organization.

For the optional file-local `Service` / `Interface` convention with a canonical self-exported ES module namespace, read [MODULE_STYLE.md](MODULE_STYLE.md). It is not required by Effect; named service classes remain appropriate for other module styles.

## Layer Constructors

Choose the layer constructor that matches the thing produced.

```ts
Layer.succeed(Service, impl); // already-built service
Layer.sync(Service, () => impl); // lazy synchronous service
Layer.effect(Service, makeEffect); // effectful service acquisition
```

Guidance:

- Default real implementations to `Layer.effect(Service, Effect.gen(...))`.
- Use `Layer.effectContext(...)` when one acquisition intentionally supplies multiple services, especially first-class test stubs or one client backing several service tags.
- Use `Layer.unwrap(...)` when config or runtime discovery chooses/builds the layer.
- Use `Layer.fresh(...)` or `Effect.provide(layer, { local: true })` only when a test or operation needs isolated acquisition.
- Use `Context.Reference` rarely, only for ambient/defaultable runtime references where a safe default is real.

## Long-Lived Work

A layer that starts a stream, listener, worker, subscription, or forever loop must fork that work into the layer scope. Layer acquisition must complete. The following illustrates lifetime ownership only; required workers also need the failure-observation policy below.

```ts
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Events.Service;

    yield* events.stream.pipe(Stream.runForEach(handleEvent), Effect.forkScoped);
  }),
);
```

Guidance:

- Use `Effect.forkScoped`, `FiberSet`, or `FiberMap` for scoped background work.
- Scoped forking controls cancellation, not failure propagation. Discarding the fiber can leave an application running after its worker fails.
- For required workers, retain and observe their fibers with `Fiber.join` / `Fiber.await`, or track them with `FiberSet` / `FiberMap` and observe the corresponding `join`. The owning runtime or supervisor must act on failure: shut down, restart under an explicit policy, or report best-effort termination. Merely forking another unobserved join is not supervision.
- Do not run forever work or await a forever worker inline during layer acquisition; observe it from the owning runtime after acquisition completes.
- Do not expose public `start` methods unless the domain explicitly needs manual lifecycle control.

## Runtime Wiring

- Use `Layer.provide(...)` to hide an implementation dependency.
- Use `Layer.provideMerge(...)` only when the dependency should remain exposed for downstream consumers.
- Use `Layer.mergeAll(...)` for independent exposed layers.
- Prefer flat, topologically sorted runtime layer values with named subgraphs.
- At process entrypoints, use `NodeRuntime.runMain` or `BunRuntime.runMain` from the matching platform package for signal handling, failure reporting, and exit behavior. Use `Layer.launch` to run a long-lived application Layer; it does not replace worker failure observation.
- At non-Effect framework boundaries, create and reuse a `ManagedRuntime` from the application Layer rather than rebuilding dependencies per request. Keep imperative `runPromise` / `runCallback` calls at those boundaries.
- Tie `ManagedRuntime.dispose()` (or `disposeEffect`) to the framework/application lifecycle and await cleanup before shutdown completes. Share a memo map across separate runtimes only when their dependency ownership and lifetimes intentionally overlap.

## Effect.fn

Compose workflows with `Effect.gen`. Prefer named `Effect.fn("Domain.operation")` for public and non-trivial internal service methods. Reserve `Effect.fnUntraced` for internal helpers where stack-frame or span metadata is intentionally unnecessary. Follow the project-pinned APIs and existing conventions.

Use extra `Effect.fn(...)` arguments for wrappers that apply to the whole function call. Each transform receives `(effect, ...originalArgs)`.

```ts
const readAttachment = Effect.fn("Attachment.read")(
  function* (ref: AttachmentRef) {
    return yield* api.read(ref);
  },
  (effect, ref) => effect.pipe(attachmentError("Attachment.read", { attachmentId: ref.id })),
);
```

Good whole-function transforms:

- error classification
- localized recovery
- logging annotations
- spans
- retry
- timeout
- ensuring cleanup
- small local provisioning
- result mapping

Guidance:

- Keep the generator body focused on the core workflow.
- Use transforms when the wrapper needs original arguments.
- Do not build long clever pipelines; one or two transforms is usually enough.
- Do not use this for local branch-level handling inside the workflow.

## Operation Error Helpers

For boundary errors with operation labels, prefer a shared curried `mapError` helper over hand-writing wrappers in every module.

```ts
const persistenceError = operationError(PersistenceError.make);

const row = yield * query.pipe(persistenceError("UserRepository.findById"));
```

Name the local helper after the error it produces, such as `persistenceError`, `projectionError`, or `processingError`. Use `Effect.fn(...)` and spans for observability in addition to payload labels, not instead of them.

## Nested Reason Errors

When an integration exposes a tagged error containing a tagged `reason`, prefer the typed reason operators over unchecked property inspection or broad cause recovery:

- `Effect.catchReason("OuterError", "ReasonTag", handler)` handles one nested reason; the handler receives that reason.
- `Effect.catchReasons("OuterError", handlers)` handles several reason tags.
- `Effect.unwrapReason("OuterError")` promotes reasons into the error channel when that is the intended boundary contract. Preserve outer diagnostic context when callers still need it.

Unhandled reasons remain failures. A typed `reason` is not an Effect `Cause`; interruption and defect policies remain separate.
