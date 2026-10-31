# HTTP Clients

## Contents

- [Boundary Shape](#boundary-shape)
- [Effect HttpClient](#effect-httpclient)
- [Retry And Rate Limits](#retry-and-rate-limits)
- [Timeouts And Circuit Breakers](#timeouts-and-circuit-breakers)
- [Raw Fetch Exception](#raw-fetch-exception)

Use this when writing outgoing HTTP calls, Effect HttpClient adapters, status classification, HTTP retries, or rate limiting.

When Effect HttpClient fits the application or provider boundary, use the modules supported by the project's pinned version. Effect 4 modules include:

- `effect/http/HttpClient`
- `effect/http/HttpClientRequest`
- `effect/http/HttpClientResponse`
- `effect/http/HttpClientError`

Prefer Effect HttpClient in Effect application and provider code when its typed errors, layers, and transforms are useful. Raw `fetch` remains reasonable for browser or edge constraints, small adapters, and platform transports.

## Boundary Shape

HTTP adapter methods should be named effects that own the full boundary:

- construct request
- attach auth and headers
- execute request
- classify status
- decode response body
- map transport/status/decode failures to typed domain errors
- apply retry/rate-limit policy where idempotent

Keep raw provider/network effects outside business services and database transactions.

## Effect HttpClient

Useful APIs:

- `HttpClient.mapRequest(...)` / `mapRequestEffect(...)` for configured client transforms.
- `HttpClientRequest.bodyJson(...)` for effectful JSON body encoding.
- `HttpClientRequest.schemaBodyJson(...)` for schema-backed JSON body encoding.
- `HttpClient.filterStatusOk` / `HttpClientResponse.filterStatusOk` before decoding when non-2xx responses are failures.
- `HttpClientResponse.schemaBodyJson(...)` for body-only decoding, `schemaJson(...)` for status/headers/body decoding, and `schemaNoBody(...)` for status/headers decoding.
- `HttpClient.retryTransient(...)` for common transient HTTP failures.
- `HttpClient.withRateLimiter(...)` for proactive pacing and learning from rate-limit headers. It requires a `RateLimiter` plus initial window, limit, and key options; it adds `RateLimiterError` to the error channel and retries `429` responses by default.

## Retry And Rate Limits

Use `HttpClient.retryTransient(...)` for common transient HTTP failures:

- transport errors
- timeouts
- `408`
- `429`
- `500`
- `502`
- `503`
- `504`

It honors `Retry-After`, and `HttpClient.isTransientError` / `isTransientResponse` expose the same classification. Combine it with `HttpClient.filterStatusOk`: without that, a transient status that survives every retry comes back as an ordinary response, not a failure.

Use `HttpClient.withRateLimiter(...)` when the client should proactively pace requests and learn from rate-limit / `Retry-After` headers.

- Its automatic `429` retries are unlimited by default. Set a finite `times` budget, or `times: 0` when the operation owns retry policy.
- Disabling response inspection does not disable retries; use `times: 0` for that.
- Avoid stacking limiter, transient-client, and operation retries without an explicit total attempt budget. An unlimited inner retry can prevent an outer policy from seeing exhaustion.
- Apply a whole-operation deadline where required, including pacing and retries. Retry only operations with proven idempotency, and preserve exhausted failures unless a truthful fallback exists.

Use operation-level `Effect.retry(...)` when retry depends on domain-specific typed errors, provider payloads, or idempotency rules. Read `SCHEDULING.md` for custom schedules and `retryAfterMs` typed-provider patterns.

## Timeouts And Circuit Breakers

- `HttpClient.timeout(...)` (4.1.1+) fails as a retryable transport error. Apply it before `retryTransient` to give each attempt its own budget, or after to bound the whole retry loop. Body reads outside the timed client are not covered, so time those separately. Its `@since` tag says 4.1.0, but the API is absent from that release.
- `HttpClient.withCircuitBreaker({ breaker })` (4.0.7+, experimental) guards a dependency with a breaker from `effect/persistence`. Compose in the order `withRateLimiter`, `retryTransient`, `withCircuitBreaker`, so the breaker sees one outcome per call and an open circuit skips the retry loop.
- Set `times` on `withRateLimiter` under a breaker; unlimited `429` retries can hold the half-open probe for minutes.
- `HttpClient.followRedirects` with `FetchHttpClient` needs `FetchHttpClient.RequestInit` set to `{ redirect: "manual" }`.

## Raw Fetch Exception

Use raw `fetch` deliberately for browser or edge constraints, small adapters, platform transports, or APIs that cannot use Effect HttpClient.

Keep raw `fetch` inside a named adapter effect and apply the same error, decoding, and cancellation discipline. It can remain the chosen transport while those reasons apply.

```ts
const request = Effect.fn("Provider.request")(function* (input: RequestInput) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(input.url, { signal, headers: input.headers }),
    catch: (cause) =>
      new ProviderError({ operation: "Provider.request", cause }),
  });

  if (!response.ok) {
    return yield* new ProviderRejected({
      operation: "Provider.request",
      status: response.status,
    });
  }

  const json = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new ProviderError({ operation: "Provider.decodeJson", cause }),
  });

  return yield* Schema.decodeUnknownEffect(ResponseSchema)(json).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderError({ operation: "Provider.decodeResponse", cause })
    )
  );
});
```

Guidance:

- Reconsider Effect HttpClient when constraints change or its capabilities would simplify the adapter enough to justify migration.
- Wire `AbortSignal` from `Effect.tryPromise` into `fetch`.
- Classify HTTP status before decoding successful payloads.
- Decode unknown response bodies with Schema at the boundary.
- Preserve provider evidence needed for diagnosis, but redact secrets and private payloads.
- Apply retry only for idempotent operations.
