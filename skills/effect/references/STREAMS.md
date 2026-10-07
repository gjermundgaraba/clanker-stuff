# Streams

## Contents

- [Mental Model](#mental-model)
- [Source Chooser](#source-chooser)
- [Transformation Chooser](#transformation-chooser)
- [Consumption Chooser](#consumption-chooser)
- [Long-Lived Consumers](#long-lived-consumers)
- [Queues, PubSub, And SubscriptionRef](#queues-pubsub-and-subscriptionref)
- [Backpressure And Buffers](#backpressure-and-buffers)
- [Error Handling](#error-handling)
- [Keyed Concurrency](#keyed-concurrency)
- [Tests](#tests)

Use this when working with `Stream`, event sources, async iterables, queue/pubsub-backed streams, pagination, backpressure, throttling, debouncing, or long-lived stream consumers.

## Mental Model

`Stream<A, E, R>` is an effectful source that can emit many `A` values over time, fail with `E`, and require services `R`. Streams are pull-based and backpressured; consumption controls demand.

Use streams for sources that are naturally many-valued and time-ordered:

- gateway events
- provider callbacks adapted through queues
- subscription/event logs
- paginated APIs
- file/stdin/platform streams
- scheduled ticks when values matter
- pipelines with filtering, mapping, buffering, throttling, or bounded concurrent processing

Do not use streams just to loop forever. For one repeated effect with no emitted values, use `Effect.repeat(...)` with `Schedule`; read `SCHEDULING.md`.

## Source Chooser

- Test fixtures: `Stream.fromIterable(...)`, often with `Stream.concat(Stream.never)` for an open subscription.
- Queue-backed callback boundary: `Queue` plus `Stream.fromQueue(...)`.
- Broadcast events: `PubSub` plus `Stream.fromPubSub(...)`.
- Latest-value state plus updates: `SubscriptionRef`.
- Schedule-generated ticks/values: `Stream.fromSchedule(...)`.
- Paginated pull APIs: `Stream.paginate(...)`; its effectful step returns `Effect<readonly [ReadonlyArray<A>, Option.Option<S>], E, R>`. The stream emits `A` elements, not page arrays. `Option.none()` ends pagination after emitting that step's elements; empty arrays are allowed. There is no separate `Stream.paginateEffect`.
- Async iterable/platform source: `Stream.fromAsyncIterable(...)` when no native Effect source exists.
- Effect that produces a stream after reading services/config: `Stream.unwrap(...)`.

## Transformation Chooser

- Bounded concurrent effectful transformation: `Stream.mapEffect(fn, { concurrency })`.
- Drop ordering when order is irrelevant and latency matters: `Stream.mapEffect(fn, { concurrency, unordered: true })`.
- Multiple inner streams concurrently: `Stream.flatMap(fn, { concurrency })`.
- Stateful transformation: `Stream.mapAccum(...)` / `Stream.mapAccumEffect(...)`.

## Consumption Chooser

- Side-effecting consumer: `Stream.runForEach(...)`.
- Tests/small finite streams: `Stream.runCollect`.
- First N values in tests: `Stream.take(n)` plus `Stream.runCollect`.
- Long-lived consumer in a layer: `stream.pipe(Stream.runForEach(...), Effect.forkScoped)`.

Avoid `Stream.runCollect` on unbounded or production event streams.

## Long-Lived Consumers

Own long-lived stream consumers in layers and fork them into the layer scope. This example shows lifetime ownership, not failure supervision.

```ts
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* Gateway.Service;

    yield* gateway.events.pipe(
      Stream.filter(isMessageEvent),
      Stream.runForEach(handleEvent),
      Effect.forkScoped,
    );
  }),
);
```

Guidance:

- Let the layer own the stream lifetime.
- Use `Effect.forkScoped` for lifetime ownership. It does not propagate a worker failure to the layer or runtime; required consumers need explicit fiber observation and an owner that acts on termination. See [Long-Lived Work](SERVICES_LAYERS.md#long-lived-work).
- If methods need to fork work into the layer lifetime, capture `Scope.Scope` during layer acquisition and use `Effect.forkIn(scope)` internally. Do not expose the scope as public service API.
- Preserve stream failures unless the owning boundary has a truthful recovery policy.

## Queues, PubSub, And SubscriptionRef

- Use `Queue` when each event/item should be consumed by one consumer or worker.
- Use `PubSub` when every subscriber should see every event.
- Use `SubscriptionRef` when consumers need the current value and a stream of changes.
- Expose a `Stream` from service interfaces when callers should consume events, not push into the queue.
- Keep producer queues/private refs inside the implementation or test service.

Good service shape:

```ts
export interface Interface {
  readonly events: Stream.Stream<ProviderEvent, ProviderError>;
  readonly status: Stream.Stream<ProviderStatus>;
}
```

Implementation can use private `Queue` / `SubscriptionRef`; consumers see streams.

## Backpressure And Buffers

Prefer natural stream backpressure first.

Use `Stream.buffer(...)` only when producer and consumer should decouple.

- `strategy: "suspend"`: apply backpressure when full.
- `strategy: "dropping"`: drop new values when full.
- `strategy: "sliding"`: keep the latest values by dropping old ones.
- `capacity: "unbounded"`: rare; use only when growth is bounded elsewhere.

Use `Stream.debounce(...)` for quiet-period behavior and `Stream.throttle(...)` / `Stream.throttleEffect(...)` for rate-shaped streams.

## Error Handling

- Prefer typed stream errors over defects.
- Use `Stream.mapError(...)` to translate errors at boundaries.
- Use `Stream.catchIf(...)`, `Stream.catchTag(...)`, or `Stream.catchFilter(...)` for typed recovery.
- Use `Stream.catchCause(...)` only at explicit supervision boundaries.
- Do not hide stream defects by default. For forked consumers, explicitly observe termination and surface it to the owning supervisor/runtime unless the stream is explicitly best-effort.

## Keyed Concurrency

Choose by the required per-key behavior:

- For ordinary per-key serialization, consider `Stream.groupByKey(...)` and concurrent consumption of the resulting groups, processing each group's stream sequentially.
- Account for group cardinality, buffers, and group lifetime. Limiting active group consumers can stall a long-lived stream when unconsumed groups fill their buffers; a group concurrency limit is not automatically a safe global work limit.
- Grouping does not coalesce pending values into a single latest-value rerun. For projection/reconciliation work requiring that policy, reuse a compatible keyed-run helper when available.
- When built-in operators do not express the required policy, encapsulate coordination in one named helper, using `FiberMap` where appropriate. Fiber tracking alone does not implement serialization or coalescing; test ordering, pending-work policy, cancellation, and failure observation.

## Tests

- Use `Stream.fromIterable(...)` for finite fixtures.
- Use `Stream.empty` for no events.
- Use `Stream.fromQueue(...)` with a test-owned `Queue` when the test needs to drive events interactively.
- Use `Stream.take(n)` plus `Stream.runCollect` for finite assertions.
- Avoid real sleeps; coordinate with `Deferred`, `Queue`, `Latch`, and `TestClock`.
