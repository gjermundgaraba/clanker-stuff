# Schema And Data Modeling

## Contents

- [Records](#records)
- [Construction Versus Decoding](#construction-versus-decoding)
- [Optionality And Defaults](#optionality-and-defaults)
- [Nominal Values](#nominal-values)
- [Variants](#variants)
- [Errors](#errors)

Use this when touching data models, DTOs, row schemas, wire contracts, brands, variants, optional fields, or decoders. For the Schema API, read `node_modules/effect/ai-docs/src/01_effect/02_schema/` and `src/Schema.ts`, or `packages/effect/SCHEMA.md` at the matching tag.

## Records

Default to `Schema.Struct(...)` plus a same-name `interface`.

```ts
export const User = Schema.Struct({
  id: UserId,
  name: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
});

export interface User extends Schema.Schema.Type<typeof User> {}
```

Guidance:

- Add `.annotate({ identifier: "User" })` only when tooling consumes it: HTTP API, RPC, OpenAPI/JSON Schema, docs, diagnostics, or codegen.
- Use `schema.make(...)` when construction is trusted.
- Use `schema.makeEffect(...)` when construction failure should stay in the Effect error channel. It validates typed constructor input and fails with `SchemaIssue.Issue`, not `Schema.SchemaError`.
- Decode unknown input at boundaries with `Schema.decodeUnknownEffect(...)` by default.
- Use `Schema.decodeUnknownSync(...)` only in scripts, tests, or startup paths where throwing is acceptable.
- Decode JSON text with `Schema.fromJsonString(schema)` rather than `JSON.parse` plus a separate decode.

## Construction Versus Decoding

`make` / `makeEffect` apply constructor defaults and type-side validation. They are not decoders for an unknown encoded representation. Decode a wire timestamp through its string-to-DateTime codec rather than passing the string to the decoded value's constructor.

- `Schema.decodeUnknownEffect(schema)(input)` fails with `Schema.SchemaError`.
- `schema.makeEffect(input)` also exposes `SchemaIssue.Issue`; wrap it explicitly with `Effect.mapError((issue) => new Schema.SchemaError(issue))` if the boundary needs `SchemaError`.
- `schema.make(input)` throws a plain `Error` with the issue in `cause` on validation failure; do not assume it throws `SchemaError`.
- `Schema.NumberFromString` uses JavaScript `Number(...)` coercion: empty/whitespace-only strings become `0`, and trailing junk becomes `NaN`, which `Schema.Number` accepts. It is not a strict numeric-text validator or prefix parser. Use `Schema.FiniteFromString` for finite results and validate the encoded text separately when blanks or a specific numeric grammar must be rejected.

## Optionality And Defaults

- Use `Schema.optionalKey(...)` for absent JSON/storage keys.
- Use `Schema.optional(...)` only when explicit `undefined` is part of the contract.
- Keep normalized defaulted values as required fields and apply defaults in constructors/decoding.
- Do not make domain values optional merely for construction convenience.

## Nominal Values

- Use constrained branded schemas for scalar IDs and value objects.
- Use normal schema constraints before `Schema.brand(...)` for most code.

## Variants

- Use `Data.TaggedEnum` for internal control-flow algebras; it provides constructors, `$is`, and exhaustive `$match`. Do not add a Schema solely to obtain these utilities.
- Use `Schema.TaggedStruct` for the ordinary Effect-owned `_tag` variant.
- Use `Schema.TaggedUnion` when the union needs decoding, encoding, persistence, wire validation, JSON Schema derivation, or schema composition.
- Prefer a principled split over forcing one representation everywhere: Data internally, Schema at boundaries.
- Avoid `Schema.Class` and `Schema.TaggedClass` for new data models: encoding requires a real instance and rejects a plain object that satisfies the fields. Effect's own docs use `Schema.Class`, and a repository may choose it when models carry behavior; follow that repository's convention.

## Errors

`Schema.TaggedError` is the explicit class exception for typed Effect errors. `Data.TaggedError` is also reasonable for an error that never crosses a wire or persistence boundary; repositories split on this, so follow theirs.

```ts
export class PersistenceError extends Schema.TaggedError<PersistenceError>()(
  "UserRepo.PersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {}
```

Guidance:

- Map infrastructure failures into domain-specific tagged errors at service boundaries.
- Include operation labels when they help diagnose adapter, persistence, provider, or transport failures.
- Use schema unions for public API or transport error surfaces.
- Use `Schema.Defect()` for defect-like payloads.
- Preserve interruption when catching broad causes at ingress, worker, or stream boundaries.
