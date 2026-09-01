import { parseArgs } from "node:util";

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

export const normalizeAnnotationArguments = (
  tokens: string[],
  controlledFlags: Set<string>,
): string[] => {
  if (tokens.includes("--hook")) {
    throw new Error("--hook is not supported by this Pi extension");
  }
  return tokens.filter((token) => !controlledFlags.has(token));
};

export const findAnnotationTarget = (tokens: string[]): string | undefined => {
  const { positionals } = parseArgs({
    allowPositionals: true,
    args: tokens,
    options: {
      browser: { type: "string" },
      gate: { type: "boolean" },
      json: { type: "boolean" },
      markdown: { type: "boolean" },
      "no-jina": { type: "boolean" },
      "render-html": { type: "boolean" },
      "require-approval": { type: "boolean" },
      "result-file": { type: "string" },
    },
    strict: true,
  });
  return positionals[0];
};

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
