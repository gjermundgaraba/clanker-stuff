# Observability

Use this when adding spans, structured logs, logger or exporter wiring, or defect reporting. Metric conventions vary too much across the example repositories to prescribe: follow the repository.

## Spans

- A named `Effect.fn("Domain.operation")` is the default span source. See [Effect.fn](SERVICES_LAYERS.md#effectfn).
- Use `Effect.withSpan(name, { attributes })` for sub-steps and pipelines that are not `Effect.fn` bodies.
- Use `Effect.annotateCurrentSpan(...)` for values known only partway through. Annotate rather than opening a second span for the same work.
- A span stays OK when failure rides the success channel. Record the outcome as an attribute in that case.
- Prefer transport middleware for per-request spans over a span in every handler.
- Silence noise deliberately: `Effect.withTracerEnabled(effect, false)` for polls and per-statement work, and `HttpClient.TracerDisabledWhen` for an exporter's own traffic. A predicate that always returns `true` disables all client tracing.

## Logs

Use a stable message plus a fields object rather than interpolation, and `Effect.annotateLogs` for context shared by a whole scope.

```ts
const create = Effect.fn("Orders.create")(function* (orderId: string) {
  yield* Effect.annotateCurrentSpan({ orderId });
  yield* Effect.logInfo("order created", { orderId });
});
```

- `Logger.layer([...])` replaces the current loggers. Pass `{ mergeWithExisting: true }` to add to them.
- Set the level with `Layer.succeed(References.MinimumLogLevel, "Warn")`.
- `Effect.ignore({ log: "Error", message })` logs the full cause while discarding a failure.

## Exporters

Use `effect/observability` in new projects, and `@effect/opentelemetry` when joining an existing OpenTelemetry setup. Gate the exporter on config, so an unconfigured process runs without it.

```ts
const TelemetryLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(
      Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")
    );
    return Option.isNone(endpoint)
      ? Layer.empty
      : Otlp.layerJson({
          baseUrl: endpoint.value,
          resource: { serviceName: "app" },
        }).pipe(Layer.provide(FetchHttpClient.layer));
  })
);
```

- `Otlp.layerFromConfig(...)` is the config-driven combined alternative; it requires `HttpClient` and `OtlpSerialization`.
- Short-lived processes need a shorter export interval and shutdown timeout than the defaults of 5 and 3 seconds.
- Keep a telemetry failure from taking the application down when local logging is an acceptable fallback.

## Reporting And Redaction

- Install reporters with `ErrorReporter.layer([...])`; none is registered by default, so a defect is only as visible as the boundary's own logging makes it. The module is `@stability unstable`.
- Treat telemetry as a leak surface: no raw payloads, signed URLs, or credentials in attributes or messages.
- Extend `Headers.CurrentRedactedNames` and `UrlParams.CurrentRedactedNames` for your own sensitive names. A custom list replaces the defaults, so include them.
