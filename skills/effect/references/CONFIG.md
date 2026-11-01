# Config

For the Config API, including how absence is decided, read `packages/effect/CONFIG.md` at the matching tag.

Read runtime configuration through Effect `Config` recipes and provider layers, not `process.env` in application logic: `Config.Redacted` for secrets, `Config.option` for optional values, `Config.withDefault` for defaults, `Config.schema(Schema, name)` for validated values.

- The default `ConfigProvider.fromEnv()` snapshots the environment when created; provide a new one if the environment can change during the process.
- Treat `.env`, directory, and environment providers as startup sources, not business-workflow reads.
- A service that supports runtime config can expose `layer(options)` plus a config-backed variant, so tests still pass concrete values:

```ts
export const layerConfig = (config: Config.Wrap<ClientOptions>) =>
  Layer.effect(
    Client.Service,
    Config.unwrap(config).pipe(
      Effect.flatMap(makeClient),
      Effect.map((client) => Client.Service.of(client))
    )
  );
```
