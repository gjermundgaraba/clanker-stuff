# Streams

For constructors, transformations, and sinks, read `node_modules/effect/ai-docs/src/03_stream/`.

For one repeated effect with no emitted values, use `Effect.repeat(...)` with `Schedule`, not a stream.

## Sources

- Callback source: `Stream.callback(...)`, returning `Effect.acquireRelease(attach, detach)` so the listener is removed when the stream ends.
- Broadcast events: `Stream.fromPubSub(...)`. It subscribes only when the stream runs, so earlier events are missed.
- Broadcast where nothing may be missed: `yield* PubSub.subscribe(pubsub)` first, then `Stream.fromSubscription(...)`. To combine with a snapshot, subscribe, read the snapshot, then filter live events past it.

## Consumers and service shape

- Avoid `Stream.runCollect` on unbounded or production event streams.
- Own long-lived consumers in layers, as in [Long-lived work](SERVICES_LAYERS.md#long-lived-work). If methods fork into the layer lifetime, capture `Scope.Scope` during acquisition and use `Effect.forkIn(scope)`; do not expose the scope.
- Use `Queue` when one consumer takes each item, `PubSub` when every subscriber sees every event, and `SubscriptionRef` for a current value plus a stream of changes.
- Expose a `Stream` from service interfaces when callers consume events, and keep producer queues and refs private.
- Prefer natural backpressure. Use `Stream.buffer(...)` only to decouple producer and consumer, and `capacity: "unbounded"` only when growth is bounded elsewhere.
- Prefer typed stream errors over defects.

## Keyed concurrency

Choose by the required per-key behavior:

- To serialize per key outside a stream, hold one `Semaphore.make(1)` per key under `Semaphore.withPermit`, and reclaim idle entries so the map stays bounded.
- For per-key serialization in a stream, use `Stream.groupByKey(...)` with concurrent consumption of the groups. Limiting active group consumers can stall a long-lived stream when unconsumed groups fill their buffers.
- Grouping does not coalesce pending values into one latest-value rerun. When built-in operators cannot express the policy, put coordination in one named helper, using `FiberMap` where appropriate, and test ordering, pending work, cancellation, and failure observation. Fiber tracking alone does not serialize or coalesce.
