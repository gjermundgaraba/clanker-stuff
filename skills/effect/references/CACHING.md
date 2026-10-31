# Caching, Memoization, And Request Dedupe

Use this when memoizing expensive lookups, caching per-key results with TTL, deduplicating concurrent identical calls, or considering request batching.

Prefer `effect/Cache` over a `Map` + timestamp + prune-loop cache when its keyed memoization, TTL, capacity, lifecycle, and eviction semantics fit. Concurrent `Cache.get` calls for a missing key share one lookup and `capacity` bounds the entries, so do not add in-flight tracking, prune loops, or LRU logic.

## Core Rules

- `Cache.makeWith(lookup, { capacity, timeToLive(exit, key) })` computes TTL per entry from the lookup's `Exit` — the tool for "cache successes, not failures".
- Return a zero TTL (`0` or `"0 millis"`) from `timeToLive` to avoid caching transient failures or degraded fallbacks without failing the caller. A short negative-cache TTL can be appropriate for stable failures such as not-found results.
- Cache construction is effectful. Build the cache once in the owning layer/scope and share the handle; a cache built per call caches nothing.
- Lookup services are captured at construction by default. Use `requireServicesAt: "lookup"` only when callers should supply them on each lookup; this moves lookup requirements from cache construction to the cache handle's environment type.
- `timeToLive` is optional and defaults to infinity. Specify it when freshness matters; capacity alone only bounds retained entries.
- For a single value (no key), use `Effect.cached(effect)` or `Effect.cachedWithTTL(effect, ttl)` instead of a one-key Cache. `cachedWithTTL` also accepts an `Exit => Duration.Input` callback; use it when success and failure need different TTLs.
- For cached resources that need cleanup (connections, clients), use `ScopedCache`. Use `RcMap` for reference-counted per-key resources and `LayerMap` for one layer graph per key.

## Exit-Aware TTL (cache successes, skip degraded results)

```ts
import { Cache, Duration, Effect, Exit } from "effect";

const makeResolver = Effect.gen(function* () {
  const cache = yield* Cache.makeWith(
    (channelRef: string) => resolveUncached(channelRef), // never-failing, returns { where, cacheable }
    {
      capacity: 300,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.cacheable
          ? "10 minutes"
          : Duration.zero,
    }
  );
  return (channelRef: string) =>
    Cache.get(cache, channelRef).pipe(Effect.map((resolved) => resolved.where));
});
```

For a single value, construct the cached effect once in its owning layer:

```ts
const cachedLookup =
  yield *
  Effect.cachedWithTTL(lookup, (exit) =>
    Exit.isSuccess(exit) ? "10 minutes" : 0
  );
```

Reuse `cachedLookup` on each call. The TTL callback runs after a fresh computation that succeeds or fails; zero avoids retaining failures. Interruption is never cached: the callback does not run, and the next caller recomputes. TTL begins at completion, and concurrent callers share the pending computation.

## Expensive Client Acquisition Belongs In The Layer, Not The Lookup

A cache cannot fix a lookup that pays a scoped acquisition per call, such as SDK client construction or authentication. Acquire clients once via the owning layer (`Layer.build` inside a `Layer.unwrap(Effect.gen(...))` composition, or a service dependency) so the cached lookup is a plain call:

```ts
// Bad: every cache miss acquires a fresh client
const lookup = (id: string) =>
  getRecord(id).pipe(Effect.provide(apiClientLayer(options)));

// Good: client built once for the layer's lifetime; misses are one API call
// Layer.build requires Scope.Scope; acquire this inside the owning layer's scope.
const context = yield * Layer.build(apiClientLayer(options));
const lookup = (id: string) => Context.get(context, ApiClient).getRecord(id);
```

## Request Batching (`Effect.request` + `RequestResolver`)

Batching exists for backends with a real batch endpoint: the resolver receives an array of pending requests and can collapse them into one wire call.

- Use it when the API can answer N keys in one call (SQL `IN (...)`, DataLoader-style endpoints, batch GET).
- Do not reach for it when the backend only has per-item endpoints (most REST provider APIs): a batched resolver still loops one call per entry, so it buys nothing over `Effect.forEach(items, f, { concurrency })` plus `Cache` for dedupe/memoization.
- `RequestResolver.batchN(resolver, n)` bounds batch size; `RequestResolver.makeGrouped` groups requests that must resolve through different targets.
