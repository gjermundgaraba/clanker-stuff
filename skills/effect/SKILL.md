---
name: effect
description: Effect conventions and production defaults for TypeScript. Use before writing, migrating to, or reviewing code that imports `effect` or `@effect/*`, including when introducing Effect to a repository. Load it even when another skill or repository instructions drive the task. Routine small edits that follow existing repository patterns do not need it.
metadata:
  upstream-source: "https://github.com/kitlangton/skills"
  upstream-path: "skills/effect/"
  upstream-revision: "71195e36024ebd2e66c5beac946e81eafd5abc43"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "reconciled"
---

# Effect

## Precedence

1. The nearest `AGENTS.md` and established repository conventions.
2. The installed `effect` / `@effect/*` version. Check exact imports, names, and signatures there; the references here target tag `effect@4.1.1` and may age.
3. The defaults in this skill.
4. Example repositories, for pattern research only: `github.com/{anomalyco/opencode,pingdotgg/t3code,foldkit/foldkit,alchemy-run/alchemy-effect}` under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}`. Check each one's pinned Effect version before borrowing.

Unstable Effect APIs and packages count as much as stable ones: never avoid one because it is unstable.

## Effect documentation

Resolve `node_modules/effect` from the package being changed:

- `AGENTS.md`: topic index. Read it first.
- `ai-docs/src/`: runnable examples for each topic.
- `src/`: types and JSDoc, which record gotchas. These are the API authority; where prose disagrees, the types win.
- `node_modules/@effect/vitest/README.md`: test helpers.

`MIGRATION.md`, `migration/`, and `packages/effect/{SCHEMA,CONFIG,HTTPAPI}.md` are not on npm. Read them at the tag matching the installed version, from a checkout of `Effect-TS/effect` (see the `librarian` skill). `https://effect.website/docs/v4/<guide-path>.md` serves the website guides as Markdown; it is unversioned, so verify it against the types.

## Boundaries

- Keep HTTP handlers thin: decode input, read context, call services, map typed errors to transport responses. Business rules live in services or domain functions.
- For `HttpApi`, declare the status on the error (`{ httpApiStatus: 404 }`) in a contract clients can import, and map domain errors to contract errors at the handler edge. For unexpected failures, log the cause and return a reference id, not internals.
- Yield stable services once when the handler layer is built; never `Effect.provide(layer)` per request.
- Wrap HTTP clients, SDKs, CLIs, and external integrations in named effects at adapter boundaries.
- Decode persisted rows with Schema or SQL helpers unless the values are trivially trusted.
- Keep provider and network calls outside authoritative database transactions.
- Catch or retry only when the boundary has a truthful response, and retry only proven-idempotent operations. Otherwise let the failure stay visible.
- Fix Effect type errors at their source, not with `as any`, non-null assertions, or unchecked casts.
- Recover from typed errors with typed operators; keep cause-level recovery for supervision boundaries.

## References

Read the one that matches the task; repository patterns and installed source can be enough for routine edits.

- Data models, brands, variants, optional keys, decoders, tagged errors → [SCHEMA.md](references/SCHEMA.md)
- Services, Layers, runtime entrypoints and disposal, callback bridges, background workers, mixed causes, `Effect.fn` → [SERVICES_LAYERS.md](references/SERVICES_LAYERS.md)
- Spans, logs, exporters, defect reporting → [OBSERVABILITY.md](references/OBSERVABILITY.md)
- Runtime config, environment variables, `layerConfig` → [CONFIG.md](references/CONFIG.md)
- Retry, repeat, polling, backoff, timeouts, wall-clock versus elapsed time → [SCHEDULING.md](references/SCHEDULING.md)
- Memoization, TTL caches, deduplicating lookups, request batching → [CACHING.md](references/CACHING.md)
- Streams, event sources, queues, pubsubs, backpressure, keyed concurrency → [STREAMS.md](references/STREAMS.md)
- Outgoing HTTP, `HttpClient`, status handling, rate limits → [HTTP_CLIENTS.md](references/HTTP_CLIENTS.md)
- Tests, `TestClock`, synchronization, reusable fakes → [TESTING.md](references/TESTING.md)
