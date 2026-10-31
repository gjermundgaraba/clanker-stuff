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

For reviews and audits, remain read-only and report the problem, supporting evidence, demonstrated consequence, and relevant constraints or uncertainty. Use the design and implementation guidance to assess existing or supplied designs; do not prescribe replacements, implementation steps, or a target design unless requested. A supported finding does not require a known solution.

## Source And Precedence

Resolve conflicts in this order:

1. Follow the nearest `AGENTS.md`, project-local Effect guidance, and established repository conventions.
2. Follow the project's pinned `effect` / `@effect/*` version and inspect its installed source and types for exact APIs.
3. If installed source leaves an API question unresolved, consult matching upstream source and `LLMS.md`. For explicitly current-version work, verify the current upstream version.
4. Use the matching bundled references for design patterns and production defaults.
5. Use example repositories only as version-checked pattern research.

Bundled examples target stable Effect `4.1.1`; the API baseline was checked against tag `effect@4.1.1` at upstream commit `bc492f0965dc0f6a83cefd141071c5ead10f7efa` (2026-10-30). This is not a migration requirement for older projects.

Stable Effect 4 removes the `unstable` import-path segment without stabilizing every API. Inspect `@stability` annotations: unstable APIs may break in minor releases, experimental APIs may break in patch releases, and `@stability stable` or untagged APIs follow semver. Modules in packages other than `effect` are currently unstable. Unstable Effect APIs and packages count as much as stable ones: never avoid one because it is unstable.

Exact imports, names, signatures, and module paths in bundled references may age. Verify anything version-sensitive against the project-pinned package or matching upstream source before editing.

## Upstream Research (When Needed)

Use installed source and types when they answer the question. The `effect` package also ships `AGENTS.md` and `ai-docs/` for its exact version; read them before reaching for upstream. Otherwise resolve a cached checkout under `${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}/github.com/Effect-TS/effect`; use the `librarian` helper when available. Read the relevant source and `LLMS.md` at the project's matching tag/commit, without substituting newer trunk APIs. Refresh upstream for greenfield work explicitly targeting current Effect. Verify branch/version mapping instead of assuming it. For migration or renamed-API questions, consult the matching checkout's `MIGRATION.md` and only the relevant guides under `migration/`; verify their claims against source and types.

## Reference Chooser

Consult the sections that resolve the current task. Established repository patterns and installed source can be sufficient for routine edits. Load additional references as design or API questions arise.

- Migrations from v3 or v4 prereleases, import paths, or renamed APIs: read `references/V4_APIS.md`, then the relevant functional reference. Verify against the project's pinned version before applying any change.
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
- `github.com/Kilo-Org/kilocode`
- `github.com/kitlangton/stack`
- `github.com/kitlangton/ghui`
- `github.com/UsefulSoftwareCo/executor`

Clone or refresh only the repositories needed for the task. Before borrowing a pattern, inspect its pinned Effect version and verify version-sensitive APIs against the target project. Refresh only when the research requires current source.
