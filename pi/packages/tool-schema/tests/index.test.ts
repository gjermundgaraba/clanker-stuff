import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { invalidArguments, structuralSchema } from "../index.js";

const Rich = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 8, description: "Short name" }),
    pattern: Type.Optional(Type.String({ pattern: "^[a-z]+$" })),
    sizes: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, maximum: 9 }), { minItems: 1, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

describe("tool schemas", () => {
  it("keeps the shape and moves value constraints into descriptions, sparing a property named like one", () => {
    expect(structuralSchema(Rich)).toStrictEqual({
      additionalProperties: false,
      properties: {
        name: { description: "Short name. Limits: 1–8 characters.", type: "string" },
        pattern: { description: "Limits: pattern ^[a-z]+$.", type: "string" },
        sizes: {
          description: "Limits: at least 1 items; unique items.",
          items: { description: "Limits: 1–9.", type: "integer" },
          type: "array",
        },
      },
      required: ["name"],
      type: "object",
    });
    expect(() => makeStrictJsonSchema(structuralSchema(Rich))).not.toThrow();
  });

  it("names each violation of the constrained schema", () => {
    const input = { name: "much too long" };

    expect(invalidArguments(Rich, input, "demo").message).toContain(
      "Invalid demo arguments: /name",
    );
  });
});
