# Testing

For helpers and basic shapes, read `node_modules/@effect/vitest/README.md` and `node_modules/effect/ai-docs/src/09_testing/`.

## Defaults

- Use `it.live` only when real time, processes, sockets, or file events are the behavior under test. Under `it.effect`, an Effect timeout never fires on its own, so a missed event hangs instead of failing. Use `TestClock.withLive` for one real step inside a virtual-time test.
- Use test layers and `ConfigProvider`, not global mutation.
- Share an expensive layer with `it.layer`. Pass `{ buildPerTest: true }` when tests mutate state.
- Fork sleeping effects before advancing `TestClock`. `adjust` wakes only sleeps already registered: a child that suspends before it sleeps can register too late and silently never wake. Fork it with `{ startImmediately: true }`, or have it signal a `Deferred` just before sleeping and await that before adjusting.
- Use `Effect.flip` to assert a typed failure value.
- Assert typed failures, rollback, interruption, finalization, retry bounds, idempotency, and malformed persistence where relevant.

## Synchronization instead of sleeps

Replace arbitrary `Effect.sleep(...)` with `Deferred`, `Queue`, `Latch`, or `Ref`, plus a test hook where production can expose a deterministic point. Drive a stream from a test-owned `Queue` with `Stream.fromQueue(...)`, and keep a fixture open like a live subscription with `Stream.concat(Stream.never)`.

## Reusable fakes

For a stateful fake, declare `TestInterface extends Interface` with control and inspection members, a `TestService` tag for it, and a `testLayer`:

```ts
export const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    const service = TestService.of({/* backed by Ref state */});
    return Context.empty().pipe(
      Context.add(Service, service),
      Context.add(TestService, service)
    );
  })
);
```

- The same object backs both tags. Production code depends only on `Service`; tests use `TestService`.
- Use function-valued members, including zero-argument operations, so `Effect.fn` fits.
- Use `Layer.succeed` for complete static implementations.
- Use `Layer.mock` for small partial stubs. Omitted Effect-returning members die with `UnimplementedError` when called. When every member returns an Effect, `Layer.mock(Service)({})` marks a service the test must not call.

## Config in tests

Use `ConfigProvider.layer(ConfigProvider.fromUnknown(...))` to exercise Config decoding, and `Layer.succeed(AppConfiguration.Service, config)` when decoding is not under test.
