import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
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
    linked_interaction_id: Type.Optional(Id),
    questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
  },
  { additionalProperties: false },
);
const RevisionSchema = Type.Object(
  {
    revise: Type.Object(
      {
        interaction_id: Id,
        base_revision: Type.Integer({ minimum: 1 }),
        reason: text(2000),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const RequestSchema = Type.Union([QuestionnaireSchema, RevisionSchema], {
  type: "object",
  // Some providers discover tool arguments only through root properties.
  // Without these, Grok via Copilot repeats empty calls. Keep the union to
  // enforce required fields, mutually exclusive branches and unknown-key rejection.
  properties: { ...QuestionnaireSchema.properties, ...RevisionSchema.properties },
});
export type Questionnaire = Static<typeof QuestionnaireSchema>;
export type Question = Static<typeof QuestionSchema>;
export type Request = Static<typeof RequestSchema>;

export function validateRequest(input: unknown): Request {
  if (!Value.Check(RequestSchema, input))
    throw new Error(
      "Invalid questionnaire arguments: " +
        [...Value.Errors(RequestSchema, input)]
          .map((e) => `${e.instancePath}: ${e.message}`)
          .join("; "),
    );
  const request = structuredClone(input);
  if ("revise" in request) {
    if (!displayText(request.revise.reason).trim())
      throw new Error("Revision reason must not be blank");
    return request;
  }
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

// The surviving async name occurs in existing Pi sessions. Prepare only its retired
// persisted call shape; the public schema and all new authoring remain rich-only.
const PersistedAsyncCall = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        { title: Type.String(), options: Type.Optional(Type.Array(Type.String())) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);
export function prepareAsyncArguments(args: unknown): Request {
  if (!Value.Check(PersistedAsyncCall, args)) return validateRequest(args);
  const questions = args.questions.map((q, i) => {
    const question: Question = { id: `q${i + 1}`, header: `Q${i + 1}`, question: q.title };
    if (q.options) question.options = q.options.map((label, j) => ({ id: `o${j + 1}`, label }));
    return question;
  });
  return validateRequest({ questions });
}
