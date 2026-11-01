# Services, Layers, and modules

For basic shapes, read `node_modules/effect/ai-docs/src/01_effect/03_services/` and `06_running/`.

## Module surface

Follow the repository's service naming and export conventions. Export only intentional surface. Do not introduce TypeScript `namespace` declarations.

Some applications name a file's members `Service`, `Interface`, and `layer`, and self-export one namespace (`export * as UserRepo from "./user-repo.js"`). Follow that where the repository already does; otherwise use a named service class.

## Layer constructors

- `Layer.effectContext(...)` when one acquisition supplies multiple services, such as test stubs or one client behind several tags.
- `Layer.unwrap(...)` when config or runtime discovery chooses the layer.
- `Layer.fresh(...)` or `Effect.provide(layer, { local: true })` only when a test or operation needs isolated acquisition.
- `Context.Reference` only for ambient runtime references with a real safe default, never for required authority, credentials, persistence, transports, or external services.

## Long-lived work

A layer that starts a stream, listener, worker, subscription, or forever loop forks it into the layer scope (`Layer.effectDiscard` plus `Effect.forkScoped`). Acquisition must complete, so never run or await forever work inline; observe it from the owning runtime afterwards.

- A plain fork only schedules the child, so a subscriber can miss what happens next. Pass `{ startImmediately: true }` when the child must register a listener or subscription before acquisition continues.
- Scoped forking controls cancellation, not failure propagation: discarding the fiber can leave the application running after its worker fails.
- Observe a required worker with `Fiber.join` / `Fiber.await`, or track it with `FiberSet` / `FiberMap` and observe their `join`. The owner must act on failure: shut down, restart under an explicit policy, or report termination. Forking another unobserved join is not supervision.
- The alternative is a total loop: handle each item's failure inside the loop, or end the fork in one `Effect.catchCause` that routes to the owner's crash path.
- Expose a public `start` method only when the domain needs manual lifecycle control.

## Runtime wiring

- `Layer.provide(...)` hides a dependency, `Layer.provideMerge(...)` keeps it exposed for downstream consumers, and `Layer.mergeAll(...)` combines independent exposed layers. Choose by what should be exposed, not by what compiles.
- Prefer flat, topologically sorted runtime layer values with named subgraphs.
- Layers memoize by identity, and sibling `Effect.provide` calls each build their own copy. Bind a shared layer to one value and provide it once at the outermost owner (`migration/layer-memoization.md`).
- At process entrypoints, use `NodeRuntime.runMain` or `BunRuntime.runMain`, and `Layer.launch` for a long-lived application Layer. `Layer.launch` does not replace worker failure observation.
- Inside running Effect code, bridge native callbacks with the captured context: `const runFork = Effect.runForkWith(yield* Effect.context<never>())`, or `FiberSet.makeRuntime` when the scope should own those fibers. A bare `Effect.runPromise` drops the caller's services and `Clock`, so a test can end up waiting in real time.
- At non-Effect framework boundaries, build one `ManagedRuntime` from the application Layer and reuse it. Tie `dispose()` to the application lifecycle and await it before shutdown completes. Share a memo map across runtimes only when their dependency lifetimes intentionally overlap.

## Effect.fn

Name `Effect.fn("Domain.operation")` on public and non-trivial internal service methods: the name creates the span, and an anonymous `Effect.fn(function* ...)` adds only a stack frame. Each extra transform receives `(effect, ...originalArgs)`; one or two is usually enough, and branch-level handling stays in the body.

## Mixed causes

A cause can hold a typed error and a defect at once, for example when a finalizer dies after the effect failed. Since 4.0.6, defects win: every typed recovery operator on `Effect`, `Stream`, and `Channel`, including `catch`, `ignore`, and `retry`, skips such a cause without running its handler. An interruption beside a typed error does not block recovery. Use `Effect.catchDefect` or `Effect.catchCause` when a boundary truly must recover from defects (`migration/error-handling.md`).

For a tagged error containing a tagged `reason`, use `Effect.catchReason`, `catchReasons`, or `unwrapReason`, not unchecked property inspection; see `node_modules/effect/ai-docs/src/01_effect/04_errors/20_reason-errors.ts`.
