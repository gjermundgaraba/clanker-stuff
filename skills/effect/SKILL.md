---
name: effect
description: Effect conventions and production defaults for TypeScript. Use before writing, migrating to, or reviewing code that imports `effect` or `@effect/*` (services and Layers, Schema, Config, HTTP clients, streams, caching, scheduling, observability, tests), including when introducing Effect to a repository that does not use it yet. Load it even when another skill (a review, planning, or framework skill) or repository instructions already drive the task; they do not replace it. Routine small edits that follow existing repository patterns do not need it.
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

Use repository-compatible Effect APIs and the production defaults in this skill. Treat the bundled references as preferred playbooks, not API authority.

## Source And Precedence

Resolve conflicts in this order:

1. Follow the nearest `AGENTS.md`, project-local Effect guidance, and established repository conventions.
2. Follow the installed `effect` / `@effect/*` version, using the sources below. Exact imports, names, and signatures in the bundled references may age; check them there before editing.
3. Use the matching bundled references for design patterns and production defaults.
4. Use example repositories only as version-checked pattern research.

Bundled examples target stable Effect `4.1.1`; the API baseline was checked against tag `effect@4.1.1` at upstream commit `bc492f0965dc0f6a83cefd141071c5ead10f7efa` (2026-10-30).

Inspect `@stability` annotations; `MIGRATION.md` ("Unstable Module System") defines the tiers. Unstable Effect APIs and packages count as much as stable ones: never avoid one because it is unstable.

## Effect Documentation

Resolve `node_modules/effect` from the package being changed. It matches the installed version exactly:

- `node_modules/effect/AGENTS.md`: topic index into the examples. Read it first.
- `node_modules/effect/ai-docs/src/`: runnable examples for each topic.
- `node_modules/effect/src/`: types and JSDoc, which also record gotchas. These are the API authority; where prose disagrees with the types, the types win.
- `node_modules/@effect/vitest/README.md`: test helpers, when installed.

`MIGRATION.md`, `migration/`, and `packages/effect/{SCHEMA,CONFIG,HTTPAPI}.md` are not published to npm. When you need them, read them at the tag matching the installed version from a checkout under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}/github.com/Effect-TS/effect` (see the `librarian` skill). Verify branch/version mapping instead of assuming it.

`https://effect.website/docs/v4/<guide-path>.md` serves each website guide as Markdown (there is no `llms.txt`). The site is unversioned and can lag the source, so verify anything it says against the installed types.

## Reference Chooser

Consult the sections that resolve the current task. Established repository patterns and installed source can be sufficient for routine edits.

- Data models, schemas, brands, variants, optional keys, or decoders: read `references/SCHEMA.md`.
- Service tags and interfaces, module surfaces, Layer constructors and combinators, runtime entrypoints and disposal, callback bridges, worker supervision, typed errors, mixed causes and nested reasons, or `Effect.fn`: read `references/SERVICES_LAYERS.md`.
- Spans, structured logs, logger wiring, telemetry exporters, or defect reporting: read `references/OBSERVABILITY.md`.
- Runtime config, environment variables, `ConfigProvider`, or `layerConfig`: read `references/CONFIG.md`.
- Retry, repeat, polling, backoff, jitter, rate-limit-aware policies, pass loops, or wall-clock versus elapsed time: read `references/SCHEDULING.md`.
- Memoization, per-key TTL caches, deduplicating concurrent lookups, or request batching: read `references/CACHING.md`.
- Streams, event sources, async iterables, queues, pubsubs, pagination, backpressure, or stream consumers: read `references/STREAMS.md`.
- Outgoing HTTP calls, Effect `HttpClient`, status handling, or HTTP rate limiting: read `references/HTTP_CLIENTS.md`.
- Effect tests, `TestClock`, deterministic synchronization, reusable test-control services, or fake implementation mechanics: read `references/TESTING.md`.

## Boundary Rules

- Keep HTTP handlers thin: decode input, read context, call services, and map typed errors to transport responses.
- For `HttpApi`, declare the status on the error (`{ httpApiStatus: 404 }`) in a contract that clients can import, and map domain errors to those contract errors at the handler edge. For unexpected failures, log the cause and return a reference id rather than internals.
- Yield stable services once when the handler layer is built; do not `Effect.provide(layer)` per request.
- Keep business rules in services or domain functions, not transport handlers.
- Wrap HTTP clients, SDKs, CLIs, and external integrations in named effects at adapter boundaries.
- Decode persisted rows with Schema or SQL-specific helpers when values are not trivially trusted.
- Keep provider and network calls outside authoritative database transactions.
- Catch or retry only when the current boundary has a truthful response.
- Retry only when the operation has proven idempotency.
- Let exhausted failures remain visible unless the boundary has a real fallback.

## Do Nots

- Do not use `as any`, non-null assertions, or unchecked casts to silence Effect typing problems.
- Do not use cause-level recovery when typed-error recovery is enough.
- Do not use `Layer.mergeAll(...)` or `provideMerge(...)` as blind make-it-compile tools.
- Do not hide required authority, credentials, persistence, transports, or external services behind `Context.Reference` defaults.

## Example Repositories

Resolve examples under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}`:

- `github.com/anomalyco/opencode`
- `github.com/pingdotgg/t3code`
- `github.com/foldkit/foldkit`
- `github.com/alchemy-run/alchemy-effect`

Clone or refresh only the repositories needed for the task. Before borrowing a pattern, inspect its pinned Effect version and verify version-sensitive APIs against the target project.
