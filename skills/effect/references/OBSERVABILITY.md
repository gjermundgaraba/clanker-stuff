# Observability

Metric conventions vary too much to prescribe: follow the repository.

## Spans

- A named `Effect.fn("Domain.operation")` is the default span source. See [Effect.fn](SERVICES_LAYERS.md#effectfn).
- Use `Effect.withSpan(name, { attributes })` for sub-steps and pipelines that are not `Effect.fn` bodies.
- Use `Effect.annotateCurrentSpan(...)` for values known partway through, rather than a second span for the same work.
- A span stays OK when failure rides the success channel. Record the outcome as an attribute.
- Prefer transport middleware for per-request spans over a span in every handler.
- Silence noise deliberately: `Effect.withTracerEnabled(effect, false)` for polls and per-statement work, `HttpClient.TracerDisabledWhen` for an exporter's own traffic. A predicate that always returns `true` disables all client tracing.

## Logs

- Use a stable message plus a fields object rather than interpolation, and `Effect.annotateLogs` for context shared by a scope.
- `Logger.layer([...])` replaces the current loggers. Pass `{ mergeWithExisting: true }` to add to them.
- Set the level with `Layer.succeed(References.MinimumLogLevel, "Warn")`.

## Exporters

`node_modules/effect/AGENTS.md` ("Observability") covers which exporter to use.

- Gate the exporter on config so an unconfigured process runs without it: `Layer.unwrap` over `Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"))`, returning `Layer.empty` when absent and `Otlp.layerJson({ baseUrl, resource }).pipe(Layer.provide(FetchHttpClient.layer))` when set.
- `Otlp.layerFromConfig(...)` is the config-driven alternative; it requires `HttpClient` and `OtlpSerialization`.
- Short-lived processes need a shorter export interval and shutdown timeout than the defaults of 5 and 3 seconds.
- Keep a telemetry failure from taking the application down when local logging is an acceptable fallback.

## Reporting and redaction

- Install reporters with `ErrorReporter.layer([...])`; none is registered by default, so a defect is only as visible as the boundary's own logging.
- Keep raw payloads, signed URLs, and credentials out of attributes and messages.
- Extend `Headers.CurrentRedactedNames` and `UrlParams.CurrentRedactedNames` for your own sensitive names. A custom list replaces the defaults, so include them.
