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

const ANNOTATION_FLAGS_WITHOUT_VALUES = new Set([
  "--gate",
  "--markdown",
  "--no-jina",
  "--render-html",
]);

export const normalizeAnnotationArguments = (
  tokens: string[],
  controlledFlags: Set<string>
): string[] => {
  if (tokens.includes("--hook")) {
    throw new Error("--hook is not supported by this Pi extension");
  }
  return tokens.filter((token) => !controlledFlags.has(token));
};

export const findAnnotationTarget = (tokens: string[]): string | undefined => {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (ANNOTATION_FLAGS_WITHOUT_VALUES.has(token)) {
      continue;
    }
    if (token === "--browser") {
      index += 1;
      continue;
    }
    if (token.startsWith("--browser=")) {
      continue;
    }
    return token;
  }
  return undefined;
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
