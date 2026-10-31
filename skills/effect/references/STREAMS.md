# Streams

## Contents

- [Sources](#sources)
- [Consumption](#consumption)
- [Queues, PubSub, And SubscriptionRef](#queues-pubsub-and-subscriptionref)
- [Backpressure And Buffers](#backpressure-and-buffers)
- [Error Handling](#error-handling)
- [Keyed Concurrency](#keyed-concurrency)

Use this when working with `Stream`, event sources, async iterables, queue/pubsub-backed streams, pagination, backpressure, throttling, debouncing, or long-lived stream consumers. For constructors, transformations, and sinks, read `node_modules/effect/ai-docs/src/03_stream/`.

Do not use streams just to loop forever. For one repeated effect with no emitted values, use `Effect.repeat(...)` with `Schedule`; read `SCHEDULING.md`.

## Sources

- Callback or event-listener source: `Stream.callback(...)`, returning `Effect.acquireRelease(attach, detach)` so the listener is removed when the stream ends.
- Broadcast events: `PubSub` plus `Stream.fromPubSub(...)`. It subscribes only when the stream runs, so events published before that are missed.
- Broadcast events where nothing may be missed: `yield* PubSub.subscribe(pubsub)` first, then `Stream.fromSubscription(...)`. To combine with a snapshot, subscribe, read the snapshot, then filter live events past it.

```ts
const messages = Stream.callback<Message>((queue) => {
  const onMessage = (message: Message) => {
    Queue.offerUnsafe(queue, message);
  };
  return Effect.acquireRelease(
    Effect.sync(() => socket.on("message", onMessage)),
    () => Effect.sync(() => socket.off("message", onMessage))
  );
});
```

## Consumption

Avoid `Stream.runCollect` on unbounded or production event streams.

Own long-lived stream consumers in layers and fork them into the layer scope, as in [Long-Lived Work](SERVICES_LAYERS.md#long-lived-work).

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

Prefer natural stream backpressure first. Use `Stream.buffer(...)` only when producer and consumer should decouple, and `capacity: "unbounded"` only when growth is bounded elsewhere.

## Error Handling

- Prefer typed stream errors over defects.
- Use `Stream.catchCause(...)` only at explicit supervision boundaries.
- Do not hide stream defects by default. For forked consumers, explicitly observe termination and surface it to the owning supervisor/runtime unless the stream is explicitly best-effort.

## Keyed Concurrency

Choose by the required per-key behavior:

- To serialize operations per key outside a stream, hold one `Semaphore.make(1)` per key and run each operation under `Semaphore.withPermit`. Reclaim idle entries so the map stays bounded.
- For ordinary per-key serialization, consider `Stream.groupByKey(...)` and concurrent consumption of the resulting groups, processing each group's stream sequentially.
- Account for group cardinality, buffers, and group lifetime. Limiting active group consumers can stall a long-lived stream when unconsumed groups fill their buffers; a group concurrency limit is not automatically a safe global work limit.
- Grouping does not coalesce pending values into a single latest-value rerun. For projection/reconciliation work requiring that policy, reuse a compatible keyed-run helper when available.
- When built-in operators do not express the required policy, encapsulate coordination in one named helper, using `FiberMap` where appropriate. Fiber tracking alone does not implement serialization or coalescing; test ordering, pending-work policy, cancellation, and failure observation.
