# Scheduling and retry

For constructors and combinators, read `node_modules/effect/ai-docs/src/06_schedule/10_schedules.ts`.

Use `Schedule` for retry, polling, and pacing, not `while (true)` loops with sleeps.

## Retry

- `Effect.retry(...)` retries typed failures. A cause containing a defect or only interruption is not retried; see [mixed causes](SERVICES_LAYERS.md#mixed-causes).
- Prefer the options forms, `Effect.retry({ schedule, times, while })` and `Effect.repeat({ schedule, until, times })`: they keep the bound and predicate at the call site.
- Follow `Effect.retry(...)` with `Effect.tapError(...)` to report exhaustion and keep the typed failure. Use `Effect.retryOrElse(...)` when exhaustion has an explicit fallback.
- Retry at the narrowest boundary. A reusable policy can log attempts with `Schedule.tap(({ input }) => ...)`.
- For provider errors that carry a retry delay, use `Schedule.modifyDelay`, whose callback receives the error as `input` and the backoff as `duration`; see `node_modules/effect/ai-docs/src/52_graphql/50_errors-and-retries.ts`. For HTTP `429` handling, read [HTTP_CLIENTS.md](HTTP_CLIENTS.md).

## Polling workers

A pass that logs the full cause of expected failures and continues, while defects still terminate and reach supervision:

```ts
const run = runPass().pipe(
  Effect.ignore({ log: "Error", message: "Worker.pass_failed" }),
  Effect.repeat(Schedule.spaced("1 second"))
);
```

- A supervision boundary that reports and continues uses `Effect.catchCauseIf((cause) => !Cause.hasInterrupts(cause), ...)`.
- For batch workers, catch expected failures around each item so one bad item does not stall the batch, when retrying it later is truthful or skipping it is the product policy.

## Timeouts and delays

- Prefer `Effect.timeoutOrElse({ duration, orElse })` to fail with a domain error, and `Effect.timeoutOption(...)` when timing out is an ordinary result.
- Use `Effect.sleep(...)` in production workflows only when sleeping is the domain behavior.

## Wall time and elapsed time

- Use `DateTime` and Effect's clock-backed current time, not `Date.now()`, in application workflows. Use `Clock.currentTimeMillis` when a Unix timestamp is the contract.
- Measure elapsed time with `Clock.monotonicTimeNanos`, never by subtracting wall timestamps. Monotonic readings are process-local, not persisted timestamps or cross-process deadlines.
- Prefer built-in timeout, Schedule, and cache TTL mechanisms over tracking deadlines by hand.
