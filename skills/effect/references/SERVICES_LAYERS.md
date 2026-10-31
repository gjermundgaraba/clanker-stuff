# Services, Layers, And Modules

## Contents

- [Module Surface](#module-surface)
- [Layer Constructors](#layer-constructors)
- [Long-Lived Work](#long-lived-work)
- [Runtime Wiring](#runtime-wiring)
- [Effect.fn](#effectfn)
- [Mixed Causes](#mixed-causes)

Use this when defining service tags, module surfaces, layer implementations, runtime wiring, typed errors, or `Effect.fn` operation boundaries. For basic service and Layer shapes, read `node_modules/effect/ai-docs/src/01_effect/03_services/` and `06_running/`.

## Module Surface

Follow the repository's established service naming and export conventions. Export only intentional surface; keep local schemas, row codecs, helpers, and implementation details private. Do not introduce TypeScript `namespace` declarations for organization.

Some application repositories name a file's members `Service`, `Interface`, and `layer`, and self-export one namespace at the bottom (`export * as UserRepo from "./user-repo.js"`) so consumers write `UserRepo.Service`. Effect does not require this; follow it where the repository already does, and otherwise use a named service class.

## Layer Constructors

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
- Layers memoize by identity, and sibling `Effect.provide` calls each build their own copy. Bind a shared layer to one value and provide it once at the outermost owner (`migration/layer-memoization.md`).
- At process entrypoints, use `NodeRuntime.runMain` or `BunRuntime.runMain` from the matching platform package for signal handling, failure reporting, and exit behavior. Use `Layer.launch` to run a long-lived application Layer; it does not replace worker failure observation.
- Inside running Effect code, bridge native callbacks with the captured context: `const runFork = Effect.runForkWith(yield* Effect.context<never>())`, or `FiberSet.makeRuntime` when the scope should own those fibers. A bare `Effect.runPromise` drops the caller's services and `Clock`, so a test can end up waiting in real time.
- At non-Effect framework boundaries, create and reuse a `ManagedRuntime` from the application Layer rather than rebuilding dependencies per request. Keep imperative `runPromise` / `runCallback` calls at those boundaries.
- Tie `ManagedRuntime.dispose()` (or `disposeEffect`) to the framework/application lifecycle and await cleanup before shutdown completes. Share a memo map across separate runtimes only when their dependency ownership and lifetimes intentionally overlap.

## Effect.fn

`node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/01_effect/01_basics/02_effect-fn.ts` cover `Effect.gen`, `Effect.fn`, and `Effect.fnUntraced`. Name `Effect.fn("Domain.operation")` on public and non-trivial internal service methods: the name creates the span, and an anonymous `Effect.fn(function* ...)` adds only a stack frame. Each extra `Effect.fn(...)` transform receives `(effect, ...originalArgs)`; one or two is usually enough, and branch-level handling stays in the body.

## Mixed Causes

A cause can hold a typed error and a defect at once, for example when a finalizer dies after the effect failed. Since 4.0.6, defects win: every typed recovery operator on `Effect`, `Stream`, and `Channel`, including `catch`, `ignore`, and `retry`, skips such a cause without running its handler. An interruption beside a typed error does not block recovery. Use `Effect.catchDefect` or `Effect.catchCause` when a boundary truly must recover from defects. See `migration/error-handling.md`.

For a tagged error containing a tagged `reason`, use `Effect.catchReason`, `catchReasons`, or `unwrapReason` rather than unchecked property inspection or cause recovery; see `node_modules/effect/ai-docs/src/01_effect/04_errors/20_reason-errors.ts`.
