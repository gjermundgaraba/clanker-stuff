# Schema and data modeling

For the API, read `node_modules/effect/ai-docs/src/01_effect/02_schema/` and `src/Schema.ts`, or `packages/effect/SCHEMA.md` at the matching tag.

## Records

Default to `Schema.Struct(...)` plus a same-name `export interface User extends Schema.Schema.Type<typeof User> {}`.

Avoid `Schema.Class` and `Schema.TaggedClass` for new data models: encoding requires a real instance and rejects a plain object that satisfies the fields. Effect's own docs use `Schema.Class`, and a repository may choose it when models carry behavior; follow that repository.

Add `.annotate({ identifier: "User" })` only when tooling consumes it: HTTP API, RPC, OpenAPI/JSON Schema, docs, diagnostics, or codegen.

## Construction versus decoding

- Decode unknown input at boundaries with `Schema.decodeUnknownEffect(...)`, failing with `Schema.SchemaError`. Keep `decodeUnknownSync` to scripts, tests, and startup paths where throwing is acceptable.
- Decode JSON text with `Schema.fromJsonString(schema)`, not `JSON.parse` plus a decode.
- `schema.make` / `makeEffect` apply constructor defaults and type-side validation; they do not decode an encoded representation. A wire timestamp goes through its string-to-DateTime codec.
- `schema.make(input)` throws a plain `Error` with the issue in `cause`. `schema.makeEffect(input)` fails with `SchemaIssue.Issue`; wrap it with `Effect.mapError((issue) => new Schema.SchemaError(issue))` if the boundary needs `SchemaError`.
- `Schema.NumberFromString` uses `Number(...)` coercion: blank strings become `0`, and trailing junk becomes `NaN`, which `Schema.Number` accepts. Use `Schema.FiniteFromString` for finite results, and validate the encoded text separately when blanks or a numeric grammar must be rejected.

## Optionality and defaults

- Use `Schema.optionalKey(...)` for absent JSON or storage keys, and `Schema.optional(...)` only when explicit `undefined` is part of the contract.
- Keep normalized defaulted values as required fields, with defaults applied in constructors or decoding. Do not make domain values optional for construction convenience.

## Nominal values

Use branded schemas for scalar IDs and value objects, with normal constraints before `Schema.brand(...)`.

## Variants

Data internally, Schema at boundaries:

- `Data.TaggedEnum` for internal control-flow algebras; do not add a Schema just for its utilities.
- `Schema.TaggedStruct` for the ordinary `_tag` variant.
- `Schema.TaggedUnion` when the union needs decoding, encoding, persistence, wire validation, JSON Schema, or composition.

## Errors

- `Schema.TaggedError` is the explicit class exception for typed errors. `Data.TaggedError` is also reasonable for an error that never crosses a wire or persistence boundary; follow the repository.
- Map infrastructure failures to domain-specific tagged errors at service boundaries, with operation labels when they help diagnosis.
- Use schema unions for public API or transport error surfaces, and `Schema.Defect()` for defect-like payloads.
- Preserve interruption when catching broad causes at ingress, worker, or stream boundaries.
