import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { invalidArguments, structuralSchema } from "@clanker-stuff/pi-tool-schema";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const MAX_QUESTIONS = 5;

export const MAX_OPTIONS = 5;

export const MAX_TEXT = 4000;

export const MAX_NOTE = 1000;

const id = (description?: string) =>
  Type.String({
    pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$",
    ...(description === undefined ? {} : { description }),
  });

export const Id = id();

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });

export const QuestionSchema = Type.Object(
  {
    id: Id,
    header: text(64),
    question: text(1000),
    context: Type.Optional(text(12000)),
    multi_select: Type.Optional(Type.Boolean()),
    options: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Id,
            label: text(256),
            description: Type.Optional(text(2000)),
            preview: Type.Optional(text(12000)),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: MAX_OPTIONS },
      ),
    ),
    recommendation: Type.Optional(
      Type.Object(
        {
          option_ids: Type.Array(Id, { minItems: 1, maxItems: MAX_OPTIONS, uniqueItems: true }),
          reason: text(2000),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const QuestionnaireSchema = Type.Object(
  {
    title: Type.Optional(text(256)),
    context: Type.Optional(text(12000)),
    linked_interaction_id: Type.Optional(
      id(
        "interaction_id of an earlier questionnaire in this session that this one follows up on. Omit for a standalone questionnaire; never invent one",
      ),
    ),
    questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
  },
  { additionalProperties: false },
);

export const RevisionSchema = Type.Object(
  {
    interaction_id: id("interaction_id returned with the answers being reopened"),
    base_revision: Type.Integer({
      minimum: 1,
      description:
        "Latest submitted revision of that questionnaire, as returned with its answers. A stale revision is rejected",
    }),
    reason: text(2000),
  },
  { additionalProperties: false },
);

// Tools publish the structural shape so every provider's strict sampling subset
// can represent it; the validators below enforce the limits declared above.
export const QuestionnaireParameters = structuralSchema(QuestionnaireSchema);

export const RevisionParameters = structuralSchema(RevisionSchema);

export type Questionnaire = Static<typeof QuestionnaireSchema>;

export type Question = Static<typeof QuestionSchema>;

export type Revision = Static<typeof RevisionSchema>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Schema boundary for tool arguments and persisted requests.
export function validateQuestionnaire(input: unknown): Questionnaire {
  if (!Value.Check(QuestionnaireSchema, input))
    throw invalidArguments(QuestionnaireSchema, input, "questionnaire");

  const request = structuredClone(input);
  const ids = new Set<string>();

  for (const q of request.questions) {
    if (ids.has(q.id)) throw new Error(`Duplicate question ID: ${q.id}`);
    ids.add(q.id);

    if (!displayText(q.header).trim() || !displayText(q.question).trim())
      throw new Error("Question headers and prompts must not be blank");
    const options = new Set<string>();
    const labels = new Set<string>();

    for (const o of q.options ?? []) {
      if (options.has(o.id)) throw new Error(`Duplicate option ID: ${o.id}`);
      options.add(o.id);
      const label = displayText(o.label).trim().toLowerCase();

      if (!label || label === "other" || labels.has(label))
        throw new Error("Use distinct, nonblank options; the UI supplies the custom-answer route");
      labels.add(label);
    }

    if (
      q.recommendation &&
      (q.recommendation.option_ids.some((id) => !options.has(id)) ||
        (!q.multi_select && q.recommendation.option_ids.length > 1) ||
        !displayText(q.recommendation.reason).trim())
    )
      throw new Error(`Invalid recommendation: ${q.id}`);
  }

  return request;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Schema boundary for tool arguments.
export function validateRevision(input: unknown): Revision {
  if (!Value.Check(RevisionSchema, input))
    throw invalidArguments(RevisionSchema, input, "revision");

  if (!displayText(input.reason).trim()) throw new Error("Revision reason must not be blank");

  return structuredClone(input);
}
