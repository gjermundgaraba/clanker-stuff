import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

// Providers' strict sampling subsets disagree on value constraints, and some
// reject a request that carries one. Shape keywords are portable everywhere.
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
  }),
);

const VALUE_CONSTRAINTS = new Set(Object.keys(Constraints.properties));

const Described = Type.Object({ description: Type.String() });

const range = (min: number | undefined, max: number | undefined, unit: string) =>
  min !== undefined && max !== undefined
    ? [min === max ? `exactly ${min}${unit}` : `${min}–${max}${unit}`]
    : min !== undefined
      ? [`at least ${min}${unit}`]
      : max !== undefined
        ? [`at most ${max}${unit}`]
        : [];

// The model cannot see a stripped constraint, so its meaning moves into the
// description: the limit is still enforced when the call executes.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- JSON Schema nodes are open records; the constraint keywords are parsed before use.
const limits = (node: Record<string, unknown>): string[] => {
  if (!Value.Check(Constraints, node)) return [];

  return [
    ...range(node.minLength, node.maxLength, " characters"),
    ...range(node.minItems, node.maxItems, " items"),
    ...range(node.minimum, node.maximum, ""),
    ...(node.exclusiveMinimum !== undefined ? [`greater than ${node.exclusiveMinimum}`] : []),
    ...(node.exclusiveMaximum !== undefined ? [`less than ${node.exclusiveMaximum}`] : []),
    ...(node.multipleOf !== undefined ? [`multiple of ${node.multipleOf}`] : []),
    ...(node.uniqueItems === true ? ["unique items"] : []),
    ...(node.format !== undefined ? [`format ${node.format}`] : []),
    ...(node.pattern !== undefined ? [`pattern ${node.pattern}`] : []),
  ];
};

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- JSON Schema is an open tree: keyword values are schemas, arrays or plain data, and only object nodes are traversed.
const isSchemaNode = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- JSON Schema is an open tree; only schema-valued keywords are traversed.
const strip = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(strip);

  if (!isSchemaNode(node)) return node;

  const summary = limits(node);

  const description = Value.Check(Described, node)
    ? `${node.description.replace(/[.\s]*$/, "")}. `
    : "";

  return Object.fromEntries([
    ...Object.entries(node)
      .filter(([key]) => !VALUE_CONSTRAINTS.has(key))
      .map(([key, value]) => [
        key,
        // Property names are data: a property called `pattern` must survive.
        key === "properties" && isSchemaNode(value)
          ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strip(child)]))
          : key === "items" || key === "anyOf" || key === "additionalProperties"
            ? strip(value)
            : value,
      ]),
    // A later entry replaces the original description.
    ...(summary.length > 0
      ? [["description", `${description}Limits: ${summary.join("; ")}.`]]
      : []),
  ]);
};

/**
 * The wire schema for a tool that requests strict sampling: the same shape as
 * `schema` with value constraints moved into descriptions. Check arguments against `schema` inside `execute`.
 */
export const structuralSchema = <T extends TSchema>(schema: T): T =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: removing value constraints leaves every type, property and required list intact, so the static type is unchanged.
  strip(schema) as T;

/** Why `input` fails the constrained schema, naming each violation. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Schema boundary: describes arbitrary tool arguments that already failed the schema.
export const invalidArguments = (schema: TSchema, input: unknown, label: string) =>
  new Error(
    `Invalid ${label} arguments: ` +
      [...Value.Errors(schema, input)].map((e) => `${e.instancePath}: ${e.message}`).join("; "),
  );
