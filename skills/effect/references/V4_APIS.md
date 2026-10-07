# Effect 4 API Checkpoints

Use this for migrations from v3 or v4 prereleases. Follow the source/version precedence and stability caveats in [`../SKILL.md`](../SKILL.md); these checkpoints are not a requirement to migrate older projects.

## Imports

Stable v4 groups modules by domain without the prerelease `unstable` segment:

```ts
import { Config, Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { Rpc, RpcGroup } from "effect/rpc";
import { Atom } from "effect/reactivity";
import { TestClock } from "effect/testing";
```

Direct imports such as `effect/http/HttpClient` also work. Check the project's `effect/package.json` exports instead of mechanically moving every `@effect/*` package into `effect`: platform adapters, framework integrations, SQL drivers, and `@effect/vitest` still have separate packages. The root barrel does not re-export every domain module. Import placement does not guarantee API stability; inspect `@stability` annotations.

## Common Migration Traps

| Older API or assumption                              | Stable v4 checkpoint                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config.string`, `boolean`, `redacted`               | `Config.String`, `Boolean`, `Redacted`; combinators remain lowercase                                                                                                                      |
| `Config.mapOrFail`                                   | `Config.mapEffect`; failure must be `Config.ConfigError`                                                                                                                                  |
| `effect/unstable/http`                               | `effect/http`                                                                                                                                                                             |
| Root `TestClock` import                              | `effect/testing`                                                                                                                                                                          |
| `Context.Tag` / `Effect.Service` service definitions | `Context.Service` plus explicit `Layer` implementations                                                                                                                                   |
| `Effect.catchAll`                                    | `Effect.catch`; prefer `catchTag` for selected tagged errors                                                                                                                              |
| `Effect.fork` / `forkDaemon`                         | `Effect.forkChild` / `forkDetach`; prefer `forkScoped` for layer-owned work                                                                                                               |
| `Either`                                             | `Result`; inspect constructors and payload fields rather than just renaming the import                                                                                                    |
| `Schema.TaggedErrorClass`                            | `Schema.TaggedError`                                                                                                                                                                      |
| Constructor validation is wire decoding              | Instance `schema.makeEffect` validates typed constructor input and fails with `SchemaIssue.Issue`; `Schema.decodeUnknownEffect` decodes unknown input and fails with `Schema.SchemaError` |

## Detailed References

- [`SCHEMA.md`](SCHEMA.md#construction-versus-decoding): constructor defaults, wire decoding, numeric coercion, and validation errors.
- [`CONFIG.md`](CONFIG.md#config-recipes): provider-based configuration, semantic absence, group defaults, and fallback behavior.
- [`SERVICES_LAYERS.md`](SERVICES_LAYERS.md): layer implementation mechanics, lifetime ownership, and worker failure observation.
- [`TESTING.md`](TESTING.md#defaults): virtual time and Effect-aware tests.

For other renamed or removed APIs, consult the matching upstream `MIGRATION.md` and relevant `migration/` guides as described in the skill. Verify source signatures and type-check representative call sites: a name appearing only in a source comment is not evidence that it is exported.
