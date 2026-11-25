import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { AnswersSchema } from "./interaction.js";
import type { Answers, Interaction } from "./interaction.js";

export const MESSAGE_TYPE = "ask-question";

const OutcomeSchema = Type.Object(
  {
    type: Type.Literal("questionnaire"),
    interaction_id: Type.String(),
    title: Type.Optional(Type.String()),
    status: Type.Enum(["answered", "pending", "closed", "dismissed"]),
    answers: Type.Optional(AnswersSchema),
  },
  { additionalProperties: false }
);

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

export const sendOutcome = (
  pi: Pick<ExtensionAPI, "sendMessage">,
  details: Outcome
): void => {
  pi.sendMessage(
    {
      customType: MESSAGE_TYPE,
      content: JSON.stringify(details),
      display: true,
      details,
    },
    { deliverAs: "steer", triggerTurn: true }
  );
};
