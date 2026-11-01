# Caching, memoization, and request dedupe

The API and its examples are in `node_modules/effect/src/Cache.ts`.

Prefer `effect/Cache` over a `Map` + timestamp + prune-loop cache when its semantics fit. Concurrent `Cache.get` calls for a missing key share one lookup and `capacity` bounds the entries, so add no in-flight tracking, prune loops, or LRU logic.

- `Cache.makeWith(lookup, { capacity, timeToLive(exit, key) })` sets TTL per entry from the lookup's `Exit`. Return a zero TTL to skip caching transient failures or degraded fallbacks. A short negative TTL suits stable failures such as not-found.
- `timeToLive` defaults to infinity, so set it when freshness matters.
- Build the cache once in the owning layer or scope and share the handle; a cache built per call caches nothing.
- For a single value, use `Effect.cached` or `Effect.cachedWithTTL(effect, ttl)`. Its TTL may be an `Exit => Duration.Input` callback. Interruption is never cached, TTL begins at completion, and concurrent callers share the pending computation.
- For cached resources that need cleanup, use `ScopedCache`. Use `RcMap` for reference-counted per-key resources and `LayerMap` for one layer graph per key.
- A cache cannot fix a lookup that pays a scoped acquisition per miss, such as `Effect.provide(apiClientLayer)` inside the lookup. Acquire the client once in the owning layer (a service dependency, or `Layer.build` in its scope) so a miss is one API call.

## Request batching

`Effect.request` plus `RequestResolver` pays off only when the backend answers N keys in one call (SQL `IN (...)`, batch GET). For per-item endpoints a resolver still loops one call per entry, so use `Effect.forEach(items, f, { concurrency })` plus `Cache`.
