# HTTP clients

For the basic shape, read `node_modules/effect/ai-docs/src/50_http-client/10_basics.ts`. Modules live under `effect/http`.

Prefer Effect `HttpClient` in application and provider code. Raw `fetch` stays reasonable for browser or edge constraints, small adapters, and platform transports.

An adapter method owns the whole boundary: build the request, attach auth, execute, classify status, decode, and map transport, status, and decode failures to typed domain errors.

- Use `HttpClientResponse.schemaBodyJson` to decode the body, `schemaJson` for status, headers, and body, and `schemaNoBody` for status and headers.

## Retry and rate limits

- `HttpClient.retryTransient(...)` retries transport errors, timeouts, `408`, `429`, `500`, `502`, `503`, and `504`, and honors `Retry-After`. Combine it with `HttpClient.filterStatusOk`: otherwise a transient status that survives every retry comes back as an ordinary response.
- `HttpClient.withRateLimiter(...)` paces requests proactively and learns from rate-limit headers. Set a finite `times`, or `times: 0` when the operation owns retry policy; its `429` retries are otherwise unlimited.
- Give stacked limiter, transient, and operation retries an explicit total budget. An unlimited inner retry hides exhaustion from an outer policy.
- Apply a whole-operation deadline where required, including pacing and retries.
- Use `Effect.retry(...)` when retry depends on domain errors or provider payloads; see [SCHEDULING.md](SCHEDULING.md).

## Timeouts and circuit breakers

- `HttpClient.timeout(...)` (4.1.1+) fails as a retryable transport error. Apply it before `retryTransient` for a per-attempt budget, or after to bound the whole loop. It does not cover body reads outside the timed client. Its `@since` tag says 4.1.0, but the API is absent from that release.
- `HttpClient.withCircuitBreaker({ breaker })` (4.0.7+) takes a breaker from `effect/persistence`. Compose `withRateLimiter`, `retryTransient`, `withCircuitBreaker` in that order, so the breaker sees one outcome per call and an open circuit skips the retry loop. Set `times` on the limiter: unlimited `429` retries can hold the half-open probe for minutes.
- `HttpClient.followRedirects` with `FetchHttpClient` needs `FetchHttpClient.RequestInit` set to `{ redirect: "manual" }`.

## Raw fetch

Keep it inside a named adapter effect. Pass the `Effect.tryPromise` `signal` to `fetch`, classify status before decoding, decode bodies with Schema, and redact secrets and private payloads from the evidence you keep.
