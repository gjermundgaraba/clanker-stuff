import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const AnnotationOutcomeSchema = Type.Union([
  Type.Object({ decision: Type.Literal("approved") }),
  Type.Object({ decision: Type.Literal("dismissed") }),
  Type.Object({
    decision: Type.Literal("annotated"),
    feedback: Type.String(),
  }),
]);

interface AnnotationNotices {
  approved: string;
  dismissed: string;
  empty: string;
}

/** Returns trimmed feedback to send, or notifies why there is none. */
export const readAnnotationFeedback = (
  stdout: string,
  ctx: ExtensionCommandContext,
  notices: AnnotationNotices,
): string | undefined => {
  let outcome: unknown;

  try {
    outcome = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Plannotator returned malformed annotation JSON");
  }

  if (!Value.Check(AnnotationOutcomeSchema, outcome)) {
    throw new Error("Plannotator returned an invalid annotation decision");
  }

  if (outcome.decision !== "annotated") {
    ctx.ui.notify(notices[outcome.decision], "info");

    return undefined;
  }

  const feedback = outcome.feedback.trim();

  if (feedback.length === 0) {
    ctx.ui.notify(notices.empty, "info");

    return undefined;
  }

  return feedback;
};
