import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import {
  invalidArguments,
  structuralSchema,
} from "@clanker-stuff/pi-tool-schema";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const MAX_QUESTIONS = 5;

export const MAX_OPTIONS = 5;

export const MAX_TEXT = 4000;

export const MAX_NOTE = 1000;

export const Id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" });

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });

export const QuestionSchema = Type.Object(
  {
    id: Id,
    header: text(64),
    question: text(1000),
    context: Type.Optional(text(12_000)),
    multi_select: Type.Optional(Type.Boolean()),
    options: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Id,
            label: text(256),
            description: Type.Optional(text(2000)),
            preview: Type.Optional(text(12_000)),
          },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: MAX_OPTIONS }
      )
    ),
    recommendation: Type.Optional(
      Type.Object(
        {
          option_ids: Type.Array(Id, {
            minItems: 1,
            maxItems: MAX_OPTIONS,
            uniqueItems: true,
          }),
          reason: text(2000),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export const QuestionnaireSchema = Type.Object(
  {
    wait: Type.Boolean({
      description:
        "true waits for the answers. false returns a pending receipt at once; the answers arrive later as a user message",
    }),
    title: Type.Optional(text(256)),
    context: Type.Optional(text(12_000)),
    questions: Type.Array(QuestionSchema, {
      minItems: 1,
      maxItems: MAX_QUESTIONS,
    }),
  },
  { additionalProperties: false }
);

export const QuestionnaireParameters = structuralSchema(QuestionnaireSchema);

export type Questionnaire = Static<typeof QuestionnaireSchema>;

export type Question = Static<typeof QuestionSchema>;

export const validateQuestionnaire = (input: unknown): Questionnaire => {
  if (!Value.Check(QuestionnaireSchema, input)) {
    throw invalidArguments(QuestionnaireSchema, input, "questionnaire");
  }

  const request = structuredClone(input);
  const ids = new Set<string>();

  for (const q of request.questions) {
    if (ids.has(q.id)) {
      throw new Error(`Duplicate question ID: ${q.id}`);
    }

    ids.add(q.id);

    if (!displayText(q.header).trim() || !displayText(q.question).trim()) {
      throw new Error("Question headers and prompts must not be blank");
    }

    const options = new Set<string>();
    const labels = new Set<string>();

    for (const o of q.options ?? []) {
      if (options.has(o.id)) {
        throw new Error(`Duplicate option ID: ${o.id}`);
      }

      options.add(o.id);
      const label = displayText(o.label).trim().toLowerCase();

      if (!label || label === "other" || labels.has(label)) {
        throw new Error(
          "Use distinct, nonblank options; the UI supplies the custom-answer route"
        );
      }

      labels.add(label);
    }

    if (
      q.recommendation &&
      (q.recommendation.option_ids.some((optionId) => !options.has(optionId)) ||
        (q.multi_select !== true && q.recommendation.option_ids.length > 1) ||
        !displayText(q.recommendation.reason).trim())
    ) {
      throw new Error(`Invalid recommendation: ${q.id}`);
    }
  }

  return request;
};
