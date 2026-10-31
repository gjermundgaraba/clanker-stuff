# Scheduling And Retry

## Contents

- [Core Rules](#core-rules)
- [Polling Workers](#polling-workers)
- [Per-Item Failure Isolation](#per-item-failure-isolation)
- [Reusable Retry Policy](#reusable-retry-policy)
- [Timeouts And Delays](#timeouts-and-delays)
- [Wall Time And Elapsed Time](#wall-time-and-elapsed-time)

Use this when writing retries, repeats, polling workers, backoff, jitter, rate-limit-aware policies, timeouts, or pass loops. For schedule constructors and combinators, read `node_modules/effect/ai-docs/src/06_schedule/10_schedules.ts`.

Use `Schedule` for retry, polling, pacing, and repeated background work instead of hand-rolled `while (true)` loops with sleeps.

## Core Rules

- `Effect.retry(...)` retries typed failures. A cause containing a defect or only interruption is not retried; a typed failure beside an interruption is. See [mixed causes](SERVICES_LAYERS.md#mixed-causes).
- Prefer the options form for an ordinary retry: `Effect.retry({ schedule, times, while })`. It keeps the bound and the retryable-error predicate at the call site. `Effect.repeat({ schedule, until, times })` is the matching polling form.
- Use `Effect.retry(...)` followed by `Effect.tapError(...)` to report exhaustion while preserving the typed failure. Use `Effect.retryOrElse(...)` when exhaustion has an explicit fallback.
- Retry at the narrowest boundary.

## Polling Workers

Prefer typed pass failures over cause recovery.

```ts
const pass = runPass().pipe(
  Effect.ignore({ log: "Error", message: "Worker.pass_failed" })
);

const run = pass.pipe(Effect.repeat(Schedule.spaced("1 second")));
```

This shape says expected operational pass failures are logged and the worker continues. Defects still defect and can reach supervision.

Use cause-level recovery only at supervision boundaries where the policy is truly "report non-interrupt failure and continue".

```ts
const logNonInterruptCauseAndContinue = (message: string) =>
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterrupts(cause),
    (cause) => Effect.logError(message, cause)
  );
```

Do not catch causes just to make failures disappear. If only expected typed failures should be recoverable, use `Effect.catchIf(...)`, `Effect.catchFilter(...)`, `Effect.catchTag(...)`, or `Effect.retry(...)` on those typed errors instead.

## Per-Item Failure Isolation

For batch workers, catch expected item-level typed failures around each item so one bad item does not stall the batch.

```ts
yield *
  Effect.forEach(
    items,
    (item) =>
      processItem(item).pipe(
        Effect.tapError((error) =>
          Effect.logError("Worker.item_failed", error).pipe(
            Effect.annotateLogs({ itemId: item.id })
          )
        ),
        Effect.ignore
      ),
    { discard: true, concurrency: 5 }
  );
```

Only do this when retrying the item later is truthful or skipping the item is the product policy.

## Reusable Retry Policy

```ts
const projectionRetrySchedule: Schedule.Schedule<unknown, ProjectionError> =
  Schedule.exponential("100 millis").pipe(
    Schedule.jittered,
    Schedule.upTo({ times: 5 })
  );

const reconcileWithRetry = (target: Target) =>
  reconcile(target).pipe(
    Effect.retry(
      projectionRetrySchedule.pipe(
        Schedule.tap(({ input: error }) =>
          Effect.logWarning("Agent.Projection.reconcile.retrying").pipe(
            Effect.annotateLogs({ operation: error.operation })
          )
        )
      )
    ),
    Effect.tapError((error) =>
      Effect.logError("Agent.Projection.reconcile.stopped", error)
    )
  );
```

Use this when the operation is idempotent and retry state is useful for logs or metrics. Exhaustion logs the final error and preserves it for the caller. Returning success after exhaustion requires an explicit product policy that permits a fallback or abandonment.

For provider errors that carry a retry delay, use `Schedule.modifyDelay`, whose callback receives the error as `input` and the backoff as `duration`, to take the larger delay; `node_modules/effect/ai-docs/src/52_graphql/50_errors-and-retries.ts` shows the shape. For Effect HttpClient-level 429 handling and proactive pacing, read `HTTP_CLIENTS.md`.

## Timeouts And Delays

- Use `Effect.timeout(...)` when the operation has a real deadline. Prefer `Effect.timeoutOrElse({ duration, orElse })` to fail with a domain error, and `Effect.timeoutOption(...)` when timing out is an ordinary result.
- Use `Effect.delay(...)` when one operation should start later.
- Use `Effect.sleep(...)` inside production workflows only when sleeping itself is the domain behavior.

## Wall Time And Elapsed Time

- Use `DateTime` for instants, parsing, formatting, time zones, and calendar arithmetic; use Effect's clock-backed current time rather than direct `Date.now()` in application workflows.
- Use `Clock.currentTimeMillis` when a Unix timestamp is the contract. Wall time can jump when the system clock is corrected; do not subtract wall timestamps to measure elapsed duration.
- Use `Clock.monotonicTimeNanos` for elapsed-time measurements. Monotonic readings are process-local measurements, not persisted timestamps or cross-process deadlines.
- Prefer built-in timeout, Schedule, and cache TTL mechanisms over manually tracking deadlines. Exercise time-dependent behavior with `TestClock`.
