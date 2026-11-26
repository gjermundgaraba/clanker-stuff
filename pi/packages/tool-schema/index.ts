import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

const Constraints = Type.Partial(
  Type.Object({
    exclusiveMaximum: Type.Number(),
    exclusiveMinimum: Type.Number(),
    format: Type.String(),
    maxItems: Type.Number(),
    maxLength: Type.Number(),
    maximum: Type.Number(),
    minItems: Type.Number(),
    minLength: Type.Number(),
    minimum: Type.Number(),
    multipleOf: Type.Number(),
    pattern: Type.String(),
    uniqueItems: Type.Boolean(),
  })
);

const VALUE_CONSTRAINTS = new Set(Object.keys(Constraints.properties));

const SchemaNode = Type.Object({
  additionalProperties: Type.Optional(Type.Unknown()),
  anyOf: Type.Optional(Type.Unknown()),
  description: Type.Optional(Type.Unknown()),
  items: Type.Optional(Type.Unknown()),
  properties: Type.Optional(Type.Unknown()),
});

type SchemaNode = Static<typeof SchemaNode>;

const Properties = Type.Record(Type.String(), Type.Unknown());

const range = (
  min: number | undefined,
  max: number | undefined,
  unit: string
): string[] => {
  if (min === undefined) {
    return max === undefined ? [] : [`at most ${max}${unit}`];
  }

  if (max === undefined) {
    return [`at least ${min}${unit}`];
  }

  return [min === max ? `exactly ${min}${unit}` : `${min}–${max}${unit}`];
};

const limits = (node: SchemaNode): string[] => {
  if (!Value.Check(Constraints, node)) {
    return [];
  }

  return [
    ...range(node.minLength, node.maxLength, " characters"),
    ...range(node.minItems, node.maxItems, " items"),
    ...range(node.minimum, node.maximum, ""),
    ...(node.exclusiveMinimum === undefined
      ? []
      : [`greater than ${node.exclusiveMinimum}`]),
    ...(node.exclusiveMaximum === undefined
      ? []
      : [`less than ${node.exclusiveMaximum}`]),
    ...(node.multipleOf === undefined
      ? []
      : [`multiple of ${node.multipleOf}`]),
    ...(node.uniqueItems === true ? ["unique items"] : []),
    ...(node.format === undefined ? [] : [`format ${node.format}`]),
    ...(node.pattern === undefined ? [] : [`pattern ${node.pattern}`]),
  ];
};

const strip = (node: unknown): void => {
  if (Array.isArray(node)) {
    for (const child of node) {
      strip(child);
    }

    return;
  }

  if (!Value.Check(SchemaNode, node)) {
    return;
  }

  const summary = limits(node);

  for (const key of VALUE_CONSTRAINTS) {
    Reflect.deleteProperty(node, key);
  }

  if (summary.length > 0) {
    const description =
      typeof node.description === "string"
        ? `${node.description.replace(/[.\s]*$/u, "")}. `
        : "";

    node.description = `${description}Limits: ${summary.join("; ")}.`;
  }

  if (Value.Check(Properties, node.properties)) {
    for (const child of Object.values(node.properties)) {
      strip(child);
    }
  }

  strip(node.items);
  strip(node.anyOf);
  strip(node.additionalProperties);
};

/**
 * The wire schema for a tool that requests strict sampling: a copy of
 * `schema` with value constraints moved into descriptions. Check arguments against `schema` inside `execute`.
 */
export const structuralSchema = <T extends TSchema>(schema: T): T => {
  const wire = Value.Clone(schema);
  strip(wire);

  return wire;
};

/** Why `input` fails the constrained schema, naming each violation. */
export const invalidArguments = (
  schema: TSchema,
  input: unknown,
  label: string
) =>
  new Error(
    `Invalid ${label} arguments: ${[...Value.Errors(schema, input)]
      .map((e) => `${e.instancePath}: ${e.message}`)
      .join("; ")}`
  );
