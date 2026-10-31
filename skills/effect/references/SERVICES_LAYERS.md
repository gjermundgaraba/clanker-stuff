# Services, Layers, And Modules

## Contents

- [Module Surface](#module-surface)
- [Layer Constructors](#layer-constructors)
- [Long-Lived Work](#long-lived-work)
- [Runtime Wiring](#runtime-wiring)
- [Effect.fn](#effectfn)
- [Mixed Causes](#mixed-causes)
- [Operation Error Helpers](#operation-error-helpers)
- [Nested Reason Errors](#nested-reason-errors)

Use this when defining service tags, module surfaces, layer implementations, runtime wiring, typed errors, or `Effect.fn` operation boundaries.

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

    yield* events.stream.pipe(
      Stream.runForEach(handleEvent),
      Effect.forkScoped({ startImmediately: true })
    );
  })
);
```

Guidance:

- Use `Effect.forkScoped`, `FiberSet`, or `FiberMap` for scoped background work.
- A plain fork only schedules the child, so a subscriber forked that way can miss whatever happens next. Pass `{ startImmediately: true }` when the child must register a listener or subscription before acquisition continues. Leave fire-and-forget work plain.
- Scoped forking controls cancellation, not failure propagation. Discarding the fiber can leave an application running after its worker fails.
- For required workers, retain and observe their fibers with `Fiber.join` / `Fiber.await`, or track them with `FiberSet` / `FiberMap` and observe the corresponding `join`. The owning runtime or supervisor must act on failure: shut down, restart under an explicit policy, or report best-effort termination. Merely forking another unobserved join is not supervision.
- A total loop is the alternative to observing the fiber: handle each item's failure inside the loop, or end the fork in one `Effect.catchCause` that routes to the owner's crash path.
- Do not run forever work or await a forever worker inline during layer acquisition; observe it from the owning runtime after acquisition completes.
- Do not expose public `start` methods unless the domain explicitly needs manual lifecycle control.

## Runtime Wiring

- Use `Layer.provide(...)` to hide an implementation dependency.
- Use `Layer.provideMerge(...)` only when the dependency should remain exposed for downstream consumers.
- Use `Layer.mergeAll(...)` for independent exposed layers.
- Prefer flat, topologically sorted runtime layer values with named subgraphs.
- Memoization follows layer identity. A factory called twice builds twice, so bind a shared layer to one value.
- A nested `Effect.provide` reuses a layer an enclosing provide or runtime already built. Sibling provides each build their own copy, so provide once at the outermost owner rather than per call.
- At process entrypoints, use `NodeRuntime.runMain` or `BunRuntime.runMain` from the matching platform package for signal handling, failure reporting, and exit behavior. Use `Layer.launch` to run a long-lived application Layer; it does not replace worker failure observation.
- Inside running Effect code, bridge native callbacks with the captured context: `const runFork = Effect.runForkWith(yield* Effect.context<never>())`, or `FiberSet.makeRuntime` when the scope should own those fibers. A bare `Effect.runPromise` drops the caller's services and `Clock`, so a test can end up waiting in real time.
- At non-Effect framework boundaries, create and reuse a `ManagedRuntime` from the application Layer rather than rebuilding dependencies per request. Keep imperative `runPromise` / `runCallback` calls at those boundaries.
- Tie `ManagedRuntime.dispose()` (or `disposeEffect`) to the framework/application lifecycle and await cleanup before shutdown completes. Share a memo map across separate runtimes only when their dependency ownership and lifetimes intentionally overlap.

## Effect.fn

Compose workflows with `Effect.gen`. Prefer named `Effect.fn("Domain.operation")` for public and non-trivial internal service methods; the name creates the span, and an anonymous `Effect.fn(function* ...)` adds only a stack frame. Use `Effect.fnUntraced` for library internals and hot paths where a span is not a useful boundary. Avoid functions that only wrap and return `Effect.gen`. Follow the project-pinned APIs and existing conventions.

Annotate the return type with `Effect.fn.Return<A, E, R>` when inference is not enough. End a failing branch with `return yield* new SomeError({ ... })`; the `return` is what lets TypeScript see that the branch stops.

Use extra `Effect.fn(...)` arguments for wrappers that apply to the whole function call. Each transform receives `(effect, ...originalArgs)`.

```ts
const readAttachment = Effect.fn("Attachment.read")(
  function* (ref: AttachmentRef) {
    return yield* api.read(ref);
  },
  (effect, ref) =>
    effect.pipe(attachmentError("Attachment.read", { attachmentId: ref.id }))
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
- Pass whole-function behavior as extra arguments rather than piping inside the body or at each call site.
- Use transforms when the wrapper needs original arguments.
- Do not build long clever pipelines; one or two transforms is usually enough.
- Do not use this for local branch-level handling inside the workflow.

## Mixed Causes

A cause can hold a typed error and a defect at once, for example when a finalizer dies after the effect failed. Since 4.0.6:

- Defects win. Every typed recovery operator on `Effect`, `Stream`, and `Channel` skips such a cause, including `catch`, `catchTag`, `catchIf`, `catchReason`, `ignore`, `option`, `result`, and `retry`. The handler does not run, and each typed error is converted to a defect.
- An interruption beside a typed error does not block recovery. `Effect.catch` handles it, and `Effect.retry` retries it.
- Mapping is not recovery. `mapError` and `mapBoth` map every typed error in place and keep defects and interrupts.
- Use `Effect.catchDefect` or `Effect.catchCause` when a boundary truly must recover from defects.

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
