# Config

Use this when reading runtime configuration, env vars, `.env` files, provider-specific settings, or writing `layerConfig(...)` helpers. For the Config API, including how absence is decided, read `packages/effect/CONFIG.md` at the matching tag.

Read runtime configuration through Effect `Config` recipes and provider layers, not direct `process.env` access inside application logic.

```ts
export const dataDirectoryConfig = Config.schema(AbsolutePath, "APP_DATA_DIR");

export const layerFromEnvironment = Layer.effect(
  Configuration.Service,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("API_KEY");
    const optionalModel = yield* Config.option(Config.String("MODEL"));
    const enabled = yield* Config.Boolean("FEATURE_ENABLED").pipe(
      Config.withDefault(false)
    );

    return Configuration.Service.of({ apiKey, optionalModel, enabled });
  })
);
```

## Config Recipes

- The default provider is `ConfigProvider.fromEnv()`. It snapshots the environment when created, so provide a new one if the environment can change during the process.
- Treat `.env`, directory, and environment providers as startup/boundary sources, not business-workflow reads.

## Layer Config Helpers

Library-style layers often expose both concrete `layer(options)` and config-backed `layerConfig(options: Config.Wrap<Options>)`.

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

Use this pattern when a service naturally supports runtime config while still allowing tests to pass concrete values.
