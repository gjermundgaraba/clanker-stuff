# Optional Module Namespace Style

Use this only when choosing or following the self-exporting namespace convention. General service and Layer mechanics belong in [SERVICES_LAYERS.md](SERVICES_LAYERS.md).

One opinionated application-module style uses file-local role names and one canonical ES module namespace projection. Follow the existing codebase's module style when it has one; this convention is not required by Effect.

```ts
export interface Interface {
  readonly get: (id: UserId) => Effect.Effect<User, NotFound | PersistenceError>;
}

export class Service extends Context.Service<Service, Interface>()("@app/UserRepo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const get = Effect.fn("UserRepo.get")(function* (id: UserId) {
      // ...
    });

    return Service.of({ get });
  }),
);

export class NotFound extends Schema.TaggedError<NotFound>()("UserRepo.NotFound", { id: UserId }) {}

export * as UserRepo from "./user-repo.js";
```

Consumers use the module namespace.

```ts
import { UserRepo } from "./user-repo.js";

const program = Effect.gen(function* () {
  const repo = yield* UserRepo.Service;
  return yield* repo.get(id);
});
```

The self-export is deliberate. It lets the file remain the module while giving every consumer the same domain-first name, without a TypeScript `namespace`, wrapper object, or repeated consumer-side aliases.

```ts
// Sibling module: import the owning leaf directly.
import { UserRepo } from "./user-repo.js";

// Folder or package barrel: relay the identity established by the leaf.
export { UserRepo } from "./user-repo.js";
```

Guidance:

- Do not name the tag class `UserRepo` inside `user-repo.ts`; the module namespace is the domain name.
- In this module style, single-file modules self-export their canonical namespace at the bottom: `export * as UserRepo from "./user-repo.js"`.
- Sibling modules import that namespace from the owning leaf; they do not import through their own aggregate barrel.
- Folder and package barrels relay established leaf identities with `export { UserRepo } from "./user-repo.js"`.
- The resulting `UserRepo.UserRepo === UserRepo` self-reference is unusual. Use this pattern only where the runtime and toolchain support it; otherwise use named exports or a separate barrel.
- Export only intentional surface; keep local schemas, row codecs, helpers, and implementation details unexported.
- Do not introduce TypeScript `namespace` declarations for organization.
- Use a named service class such as `class UserRepo extends Context.Service...` when an external library or existing codebase does not use module namespace style.
