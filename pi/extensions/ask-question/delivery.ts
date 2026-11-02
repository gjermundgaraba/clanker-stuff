import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { AnswersSchema } from "./interaction.js";
import type { Answers, Interaction } from "./interaction.js";

/** Custom message type of answers and dismissals that arrive outside a waiting tool call. */
export const MESSAGE_TYPE = "ask-question";

export const OutcomeSchema = Type.Object(
  {
    type: Type.Literal("questionnaire"),
    interaction_id: Type.String(),
    title: Type.Optional(Type.String()),
    status: Type.Enum(["answered", "pending", "closed", "dismissed"]),
    answers: Type.Optional(AnswersSchema),
  },
  { additionalProperties: false }
);

/**
 * What the model learns about a questionnaire. The same object is the text the model reads and
 * the `details` the transcript renders.
 */
export type Outcome = Static<typeof OutcomeSchema>;

export const outcome = (
  item: Interaction,
  status: Outcome["status"],
  answers?: Answers
): Outcome => ({
  type: "questionnaire",
  interaction_id: item.id,
  ...(item.request.title === undefined ? {} : { title: item.request.title }),
  status,
  ...(answers === undefined ? {} : { answers }),
});

export const readOutcome = (value: unknown): Outcome | undefined =>
  Value.Check(OutcomeSchema, value) ? value : undefined;

export const toolResult = (details: Outcome) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});

/**
 * Hands an outcome to Pi as a custom message. The model reads it as a user message; while the
 * agent runs it steers the run.
 */
export const sendOutcome = (
  pi: Pick<ExtensionAPI, "sendMessage">,
  details: Outcome,
  triggerTurn: boolean
): void => {
  pi.sendMessage(
    {
      customType: MESSAGE_TYPE,
      content: JSON.stringify(details),
      display: true,
      details,
    },
    { deliverAs: "steer", triggerTurn }
  );
};

export const delivered = (branch: SessionEntry[], id: string): boolean =>
  branch.some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === MESSAGE_TYPE &&
      readOutcome(entry.details)?.interaction_id === id
  );
