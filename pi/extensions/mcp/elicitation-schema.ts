import {
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
  PrimitiveSchemaDefinitionSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod";

// Zod records discard __proto__. Validate entries individually so JSON field names survive.
const properties = z
  .preprocess(
    (value) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Schema preprocessing must preserve arbitrary field names, including __proto__, before validating each entry.
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.entries(value)
        : undefined,
    z.array(z.tuple([z.string(), PrimitiveSchemaDefinitionSchema])),
  )
  .transform((entries) => Object.fromEntries(entries));

export const elicitationParamsSchema = z.union([
  ElicitRequestFormParamsSchema.extend({
    requestedSchema: ElicitRequestFormParamsSchema.shape.requestedSchema.extend({ properties }),
  }),
  // The SDK wrapper enforces the negotiated era first. Modern embedded URL requests
  // omit the legacy completion-notification identity.
  ElicitRequestURLParamsSchema.extend({ elicitationId: z.string().optional() }),
]);

export type ElicitationParams = z.infer<typeof elicitationParamsSchema>;
