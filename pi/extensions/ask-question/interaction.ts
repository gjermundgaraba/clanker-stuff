import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { Id, MAX_NOTE, MAX_TEXT, QuestionnaireSchema, validateRequest } from "./request.js";
import type { Questionnaire } from "./request.js";

const record = <T extends import("typebox").TSchema>(schema: T) =>
  Type.Record(Id, schema, { additionalProperties: false });

const enumOf = <T extends string>(values: T[]) => Type.Unsafe<T>({ type: "string", enum: values });

const Mode = enumOf(["blocking", "async"]);

const Fields = Type.Object(
  {
    selected: Type.Array(Id, { uniqueItems: true }),
    custom_selected: Type.Boolean(),
    custom: Type.String({ maxLength: MAX_TEXT }),
    notes: record(Type.String({ maxLength: MAX_NOTE })),
    custom_note: Type.String({ maxLength: MAX_NOTE }),
  },
  { additionalProperties: false },
);

const DraftSchema = Type.Object(
  {
    answers: record(Fields),
    note: Type.String({ maxLength: MAX_NOTE }),
    base_revision: Type.Integer({ minimum: 0 }),
    initiated_by: enumOf(["user", "agent"]),
    reason: Type.Optional(Type.String()),
    mode: Mode,
    tool_call_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const AnswerSchema = Type.Object(
  {
    question: Type.String(),
    header: Type.String(),
    selections: Type.Array(
      Type.Object(
        { option_id: Id, label: Type.String(), note: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    custom: Type.Optional(
      Type.Object(
        { text: Type.String(), note: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SubmissionSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    parent_revision: Type.Integer({ minimum: 0 }),
    timestamp: Type.String(),
    origin: Type.Literal("user"),
    initiated_by: enumOf(["user", "agent"]),
    reason: Type.Optional(Type.String()),
    tool_call_id: Type.Optional(Type.String()),
    mode: Mode,
    answers: record(AnswerSchema),
    note: Type.String(),
  },
  { additionalProperties: false },
);

export const InteractionSchema = Type.Object(
  {
    id: Id,
    request: QuestionnaireSchema,
    version: Type.Integer({ minimum: 1 }),
    created_at: Type.String(),
    updated_at: Type.String(),
    origin_tool_call_id: Type.String(),
    paused: Type.Boolean(),
    cancelled: Type.Boolean(),
    draft: Type.Optional(DraftSchema),
    submissions: Type.Array(SubmissionSchema),
    deliveries: Type.Array(
      Type.Object(
        {
          revision: Type.Integer({ minimum: 1 }),
          status: enumOf(["pending", "handed_to_pi", "delivered", "uncertain"]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Interaction = Static<typeof InteractionSchema>;

export type Draft = Static<typeof DraftSchema>;

export type Submission = Static<typeof SubmissionSchema>;

export type Answer = Static<typeof AnswerSchema>;

export type Mode = Static<typeof Mode>;

export type Action =
  | { type: "select"; question: string; option: string }
  | { type: "custom"; question: string; text: string }
  | { type: "toggle_custom"; question: string }
  | { type: "note"; question?: string; option?: string; text: string }
  | { type: "submit" }
  | {
      type: "reopen";
      base: number;
      initiated_by: "user" | "agent";
      mode: Mode;
      reason?: string;
      tool_call_id?: string;
    }
  | { type: "pause" | "resume" | "cancel" }
  | { type: "delivery"; revision: number; status: Interaction["deliveries"][number]["status"] };

export function createInteraction(
  id: string,
  request: Questionnaire,
  toolCallId: string,
  mode: Mode,
  now = new Date().toISOString(),
): Interaction {
  validateRequest(request);

  return {
    id,
    request: structuredClone(request),
    version: 1,
    origin_tool_call_id: toolCallId,
    created_at: now,
    updated_at: now,
    paused: false,
    cancelled: false,
    submissions: [],
    deliveries: [],
    draft: {
      answers: Object.fromEntries(
        request.questions.map((q) => [
          q.id,
          {
            selected: [],
            custom_selected: false,
            custom: "",
            notes: Object.fromEntries((q.options ?? []).map((o) => [o.id, ""])),
            custom_note: "",
          },
        ]),
      ),
      note: "",
      base_revision: 0,
      initiated_by: "agent",
      tool_call_id: toolCallId,
      mode,
    },
  };
}

export function collectAnswers(item: Interaction): Submission["answers"] {
  const draft = item.draft;

  if (!draft) throw new Error("No editable draft; reopen a submission first");
  const answers: Submission["answers"] = {};

  for (const q of item.request.questions) {
    const a = draft.answers[q.id];

    if (!a || (!a.selected.length && !(a.custom_selected && displayText(a.custom).trim())))
      throw new Error(`Answer required: ${q.header}`);

    if (a.custom_selected && !displayText(a.custom).trim())
      throw new Error(`Custom answer is blank: ${q.header}`);

    if (!q.multi_select && a.selected.length + Number(a.custom_selected) !== 1)
      throw new Error(`Choose one answer: ${q.header}`);

    const selections = a.selected.map((id) => {
      const option = q.options?.find((o) => o.id === id);

      if (!option) throw new Error(`Unknown option: ${id}`);
      const selection: Answer["selections"][number] = { option_id: id, label: option.label };

      if (a.notes[id]) selection.note = a.notes[id];

      return selection;
    });

    const answer: Answer = {
      question: q.question,
      header: q.header,
      selections,
    };

    if (a.custom_selected) {
      const custom: NonNullable<Answer["custom"]> = { text: a.custom };

      if (a.custom_note) custom.note = a.custom_note;
      answer.custom = custom;
    }

    answers[q.id] = answer;
  }

  if (Buffer.byteLength(JSON.stringify({ answers, note: draft.note })) > 40000)
    throw new Error(
      "Combined answers and notes exceed 40,000 UTF-8 bytes; shorten them before submitting",
    );

  return answers;
}

export function transition(
  item: Interaction,
  expectedVersion: number,
  action: Action,
  now = new Date().toISOString(),
): Interaction {
  if (item.version !== expectedVersion)
    throw new Error(
      "Stale questionnaire action; reopen the latest draft. Your editor text has been retained.",
    );
  const next = structuredClone(item);
  const draft = next.draft;

  switch (action.type) {
    case "select":
    case "custom":
    case "toggle_custom":
    case "note": {
      if (!draft || next.cancelled) throw new Error("No editable draft; reopen first");

      if (action.type === "note" && !action.question) {
        if (action.text.length > MAX_NOTE) throw new Error(`Note limit: ${MAX_NOTE} characters`);
        draft.note = action.text;
        break;
      }

      const q = next.request.questions.find((q) => q.id === action.question);

      if (!q) throw new Error("Unknown question");
      const a = draft.answers[q.id];

      if (!a) throw new Error(`Missing draft answer: ${q.id}`);

      if (action.type === "select") {
        if (!q.options?.some((o) => o.id === action.option)) throw new Error("Unknown option");
        a.selected = q.multi_select
          ? a.selected.includes(action.option)
            ? a.selected.filter((id) => id !== action.option)
            : [...a.selected, action.option]
          : [action.option];

        if (!q.multi_select) a.custom_selected = false;
      } else if (action.type === "custom") {
        if (action.text.length > MAX_TEXT) throw new Error(`Answer limit: ${MAX_TEXT} characters`);
        a.custom = action.text;
        a.custom_selected = true;

        if (!q.multi_select) a.selected = [];
      } else if (action.type === "toggle_custom") {
        a.custom_selected = !a.custom_selected;

        if (!q.multi_select && a.custom_selected) a.selected = [];
      } else {
        if (action.text.length > MAX_NOTE) throw new Error(`Note limit: ${MAX_NOTE} characters`);

        if (action.option) {
          if (!q.options?.some((o) => o.id === action.option)) throw new Error("Unknown option");
          a.notes[action.option] = action.text;
        } else a.custom_note = action.text;
      }

      break;
    }

    case "submit": {
      if (!draft || next.cancelled) throw new Error("No editable draft");
      const latest = next.submissions.at(-1)?.revision ?? 0;

      if (draft.base_revision !== latest) throw new Error("Stale base revision");

      const submission: Submission = {
        revision: latest + 1,
        parent_revision: latest,
        timestamp: now,
        origin: "user",
        initiated_by: draft.initiated_by,
        mode: draft.mode,

        answers: collectAnswers(next),
        note: draft.note,
      };

      if (draft.reason) submission.reason = draft.reason;

      if (draft.tool_call_id) submission.tool_call_id = draft.tool_call_id;
      next.submissions.push(submission);
      next.deliveries.push({ revision: submission.revision, status: "pending" });
      delete next.draft;
      break;
    }

    case "reopen": {
      if (draft)
        throw new Error(
          "An editable draft already exists; finish or cancel it before requesting a revision",
        );
      const base = next.submissions.at(-1);

      if (!base)
        throw new Error(
          next.cancelled
            ? "This request was cancelled before any answer; author a new request instead"
            : "Nothing has been submitted yet; wait for an answer before revising",
        );

      if (base.revision !== action.base)
        throw new Error(`Stale base revision; the latest submission is revision ${base.revision}`);
      next.draft = {
        base_revision: action.base,
        initiated_by: action.initiated_by,
        mode: action.mode,

        note: base.note,
        answers: Object.fromEntries(
          next.request.questions.map((q) => {
            const a = base.answers[q.id];

            if (!a) throw new Error(`Missing submitted answer: ${q.id}`);

            return [
              q.id,
              {
                selected: a.selections.map((s) => s.option_id),
                notes: Object.fromEntries(
                  (q.options ?? []).map((o) => [
                    o.id,
                    a.selections.find((s) => s.option_id === o.id)?.note ?? "",
                  ]),
                ),
                custom_selected: !!a.custom,
                custom: a.custom?.text ?? "",
                custom_note: a.custom?.note ?? "",
              },
            ];
          }),
        ),
      };

      if (action.reason) next.draft.reason = action.reason;

      if (action.tool_call_id) next.draft.tool_call_id = action.tool_call_id;
      next.cancelled = false;
      break;
    }

    case "pause":
      next.paused = true;
      break;
    case "resume":
      next.paused = false;
      break;
    case "cancel":
      next.cancelled = true;
      delete next.draft;
      break;
    case "delivery": {
      const delivery = next.deliveries.find((d) => d.revision === action.revision);

      if (!delivery) throw new Error("Unknown submission revision");

      if (delivery.status === "delivered" && action.status !== "delivered")
        throw new Error("Delivered submissions cannot be unsent");
      delivery.status = action.status;
      break;
    }
  }

  next.version++;
  next.updated_at = now;

  if (!Value.Check(InteractionSchema, next)) throw new Error("Invalid interaction state");

  return next;
}

export function submissionChanges(item: Interaction, submission: Submission): string[] {
  const previous = item.submissions.find((s) => s.revision === submission.parent_revision);

  if (!previous) return [];

  const changes = item.request.questions
    .filter(
      (q) => JSON.stringify(previous.answers[q.id]) !== JSON.stringify(submission.answers[q.id]),
    )
    .map((q) => q.header);

  if (previous.note !== submission.note) changes.push("Questionnaire note");

  return changes;
}

/** Open drafts and answers never handed to Pi still need the user; sent and cancelled ones do not. */
export function awaitingUser(item: Interaction): boolean {
  return (
    !item.cancelled &&
    (!!item.draft ||
      item.deliveries.some((d) => d.status === "pending" || d.status === "uncertain"))
  );
}
