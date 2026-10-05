import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const AnnotationOutcomeSchema = Type.Union([
  Type.Object({ decision: Type.Literal("approved") }),
  Type.Object({ decision: Type.Literal("dismissed") }),
  Type.Object({
    decision: Type.Literal("annotated"),
    feedback: Type.String(),
  }),
]);

export type AnnotationOutcome = Static<typeof AnnotationOutcomeSchema>;

export const parseAnnotationOutcome = (stdout: string): AnnotationOutcome => {
  let value: unknown;

  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Plannotator returned malformed annotation JSON");
  }

  if (!Value.Check(AnnotationOutcomeSchema, value)) {
    throw new Error("Plannotator returned an invalid annotation decision");
  }

  return value;
};
