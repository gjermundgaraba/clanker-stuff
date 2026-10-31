# Testing

## Contents

- [Defaults](#defaults)
- [Synchronization Instead Of Sleeps](#synchronization-instead-of-sleeps)
- [First-Class App Test Stubs](#first-class-app-test-stubs)
- [Config In Tests](#config-in-tests)

Use this when writing Effect tests, tests involving time, retry, schedules, concurrency, workers, services, fakes, or config.

## Defaults

```ts
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
```

Use a v4-compatible `@effect/vitest` version. `TestClock` is under `effect/testing`, not the root `effect` barrel or the old `effect/TestClock` path.

- Use `it.effect` by default.
- Use `it.live` only when real time or live runtime services are the behavior under test, or when real processes, sockets, or file events drive the code. Under `it.effect`, an Effect timeout never fires on its own, so a missed event hangs instead of failing. Use `TestClock.withLive` for one real step inside a virtual-time test.
- Use test layers and `ConfigProvider` rather than global mutation.
- Use `TestClock.setTime` / `TestClock.adjust` for sleeps, schedules, retries, leases, and timeouts.
- Fork sleeping effects before advancing `TestClock`. `adjust` wakes only sleeps already registered: a child that suspends before it sleeps can register too late and silently never wake. Fork it with `{ startImmediately: true }`, or have it signal a `Deferred` just before sleeping and await that before adjusting.
- Avoid arbitrary `Effect.sleep(...)` in tests; it usually makes tests slow and flaky.
- Use `Effect.flip` to assert a typed failure value.
- Assert typed failures, rollback, interruption, finalization, retry bounds, idempotency, concurrency laws, and malformed persistence where relevant.

```ts
it.effect("advances virtual time", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.sleep("1 second").pipe(
      Effect.as("done"),
      Effect.forkScoped
    );
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe("done");
  })
);
```

```ts
it.effect("finds a user", () =>
  Effect.gen(function* () {
    const users = yield* UserRepo.Service;
    const result = yield* users.find(UserId.make("u1"));
    expect(Option.isSome(result)).toBe(true);
  }).pipe(Effect.provide(UserRepo.testLayer))
);
```

Share an expensive layer across a suite with `it.layer`. Pass `{ buildPerTest: true }` when tests mutate state and need fresh services.

```ts
it.layer(UserRepo.testLayer)("UserRepo", (it) => {
  it.effect("finds a user", () =>
    Effect.gen(function* () {
      const users = yield* UserRepo.Service;
      expect(Option.isSome(yield* users.find(UserId.make("u1")))).toBe(true);
    })
  );
});
```

## Synchronization Instead Of Sleeps

- Use `Deferred` for one-shot readiness/completion signals.
- Use `Queue` for handing test-controlled work or observed events across fibers.
- Use `Latch` for reusable open/close coordination gates.
- Use `Ref` for shared test observation state.
- Use explicit test hooks when the production boundary can expose a deterministic synchronization point.

```ts
it.effect("publishes exactly once", () =>
  Effect.gen(function* () {
    const published = yield* Queue.unbounded<Message>();
    const ready = yield* Deferred.make<void>();

    const runWorker = makeWorker({
      onReady: () => Deferred.succeed(ready, undefined),
      onPublish: (message) => Queue.offer(published, message),
    });

    yield* runWorker.pipe(Effect.forkScoped);

    yield* Deferred.await(ready);
    const message = yield* Queue.take(published);

    expect(message).toEqual(expectedMessage);
  })
);
```

## First-Class App Test Stubs

Use `TestInterface extends Interface`, `TestService`, and `testLayer` for reusable/stateful fakes.

```ts
export interface Interface {
  readonly send: (message: Message) => Effect.Effect<void, SendError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/Notifier"
) {}

export interface TestInterface extends Interface {
  readonly sentMessages: () => Effect.Effect<ReadonlyArray<Message>>;
  readonly failNextSend: (error: SendError) => Effect.Effect<void>;
}

export class TestService extends Context.Service<TestService, TestInterface>()(
  "@app/Notifier/Test"
) {}

export const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<Message>>([]);
    const nextFailure = yield* Ref.make<Option.Option<SendError>>(
      Option.none()
    );

    const service = TestService.of({
      send: Effect.fn("Notifier.Test.send")(function* (message) {
        const failure = yield* Ref.getAndSet(nextFailure, Option.none());
        if (Option.isSome(failure)) return yield* failure.value;
        yield* Ref.update(sent, (messages) => [...messages, message]);
      }),
      sentMessages: Effect.fn("Notifier.Test.sentMessages")(function* () {
        return yield* Ref.get(sent);
      }),
      failNextSend: Effect.fn("Notifier.Test.failNextSend")(function* (error) {
        yield* Ref.set(nextFailure, Option.some(error));
      }),
    });

    return Context.empty().pipe(
      Context.add(Service, service),
      Context.add(TestService, service)
    );
  })
);
```

Guidance:

- The same object should back both the real `Service` tag and `TestService` tag.
- Production code depends only on the real service tag.
- Tests use `TestService` for control and inspection.
- Use function-valued service members, including zero-argument operations, so `Effect.fn` fits naturally.
- Use `Layer.succeed` for complete dead-simple static test implementations.
- Use `Layer.mock` for small partial stubs. Omitted Effect-returning members die with `UnimplementedError` when called; other members stay required by the types. When every member returns an Effect, `Layer.mock(Service)({})` marks a required service the test must not call.

## Config In Tests

Use `ConfigProvider.layer(ConfigProvider.fromUnknown(...))` when the test should exercise Config decoding.

Use `Layer.succeed(AppConfiguration.Service, config)` when the app wraps decoded config in its own service and the test does not need to exercise env decoding.
