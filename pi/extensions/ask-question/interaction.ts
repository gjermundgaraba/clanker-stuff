import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

import {
  Id,
  MAX_NOTE,
  MAX_TEXT,
  QuestionnaireSchema,
  validateQuestionnaire,
} from "./request.js";
import type { Question } from "./request.js";

const record = <T extends TSchema>(schema: T) =>
  Type.Record(Id, schema, { additionalProperties: false });

const Mode = Type.Enum(["blocking", "async"]);

const Initiator = Type.Enum(["user", "agent"]);

const Fields = Type.Object(
  {
    selected: Type.Array(Id, { uniqueItems: true }),
    custom_selected: Type.Boolean(),
    custom: Type.String({ maxLength: MAX_TEXT }),
    notes: record(Type.String({ maxLength: MAX_NOTE })),
    custom_note: Type.String({ maxLength: MAX_NOTE }),
  },
  { additionalProperties: false }
);

const DraftSchema = Type.Object(
  {
    answers: record(Fields),
    note: Type.String({ maxLength: MAX_NOTE }),
    initiated_by: Initiator,
    reason: Type.Optional(Type.String()),
    mode: Mode,
    tool_call_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);

const AnswerSchema = Type.Object(
  {
    question: Type.String(),
    header: Type.String(),
    selections: Type.Array(
      Type.Object(
        {
          option_id: Id,
          label: Type.String(),
          note: Type.Optional(Type.String()),
        },
        { additionalProperties: false }
      )
    ),
    custom: Type.Optional(
      Type.Object(
        { text: Type.String(), note: Type.Optional(Type.String()) },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export const submittedFields = {
  revision: Type.Integer({ minimum: 1 }),
  timestamp: Type.String(),
  initiated_by: Initiator,
  reason: Type.Optional(Type.String()),
  tool_call_id: Type.Optional(Type.String()),
  mode: Mode,
  answers: record(AnswerSchema),
  note: Type.String(),
};

const SubmissionSchema = Type.Object(
  { ...submittedFields, sent_at: Type.Optional(Type.String()) },
  { additionalProperties: false }
);

export const RequestRecordSchema = Type.Object(
  {
    id: Id,
    request: QuestionnaireSchema,
    created_at: Type.String(),
    origin_tool_call_id: Type.String(),
  },
  { additionalProperties: false }
);

export const StateRecordSchema = Type.Object(
  {
    id: Id,
    updated_at: Type.String(),
    cancelled: Type.Boolean(),
    draft: Type.Optional(DraftSchema),
    submissions: Type.Array(SubmissionSchema),
  },
  { additionalProperties: false }
);

export type RequestRecord = Static<typeof RequestRecordSchema>;

export type StateRecord = Static<typeof StateRecordSchema>;

export type Interaction = RequestRecord & StateRecord;

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
      initiated_by: Static<typeof Initiator>;
      /** Defaults to the mode of the latest submission: the way the questionnaire was last asked. */
      mode?: Mode;
      reason?: string;
      tool_call_id?: string;
    }
  | { type: "cancel" }
  | { type: "sent"; revision: number };

export const createInteraction = (
  id: string,
  input: unknown,
  toolCallId: string,
  mode: Mode,
  now = new Date().toISOString()
): Interaction => {
  const request = validateQuestionnaire(input);

  return {
    id,
    request,
    origin_tool_call_id: toolCallId,
    created_at: now,
    updated_at: now,
    cancelled: false,
    submissions: [],
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
        ])
      ),
      note: "",
      initiated_by: "agent",
      tool_call_id: toolCallId,
      mode,
    },
  };
};

export const answered = (a: Draft["answers"][string] | undefined): boolean =>
  a !== undefined &&
  (a.selected.length > 0 || a.custom_selected) &&
  (!a.custom_selected || !!displayText(a.custom).trim());

export const draftAnswer = (item: Interaction, q: Question): Answer => {
  const answer: Answer = {
    question: q.question,
    header: q.header,
    selections: [],
  };

  const a = item.draft?.answers[q.id];

  if (!a) {
    return answer;
  }

  for (const id of a.selected) {
    const selection: Answer["selections"][number] = {
      option_id: id,
      label: q.options?.find((o) => o.id === id)?.label ?? id,
    };

    if (a.notes[id] !== undefined && a.notes[id] !== "") {
      selection.note = a.notes[id];
    }

    answer.selections.push(selection);
  }

  if (a.custom_selected) {
    answer.custom = { text: a.custom };

    if (a.custom_note) {
      answer.custom.note = a.custom_note;
    }
  }

  return answer;
};

export const collectAnswers = (item: Interaction): Submission["answers"] => {
  const { draft } = item;

  if (!draft) {
    throw new Error("No editable draft; reopen a submission first");
  }

  const answers: Submission["answers"] = {};

  for (const q of item.request.questions) {
    const a = draft.answers[q.id];

    if (
      !a ||
      (!a.selected.length &&
        !(a.custom_selected && displayText(a.custom).trim()))
    ) {
      throw new Error(`Answer required: ${q.header}`);
    }

    if (a.custom_selected && !displayText(a.custom).trim()) {
      throw new Error(`Custom answer is blank: ${q.header}`);
    }

    if (
      q.multi_select !== true &&
      a.selected.length + Number(a.custom_selected) !== 1
    ) {
      throw new Error(`Choose one answer: ${q.header}`);
    }

    const unknown = a.selected.find(
      (id) => q.options?.some((o) => o.id === id) !== true
    );

    if (unknown !== undefined) {
      throw new Error(`Unknown option: ${unknown}`);
    }

    answers[q.id] = draftAnswer(item, q);
  }

  if (
    Buffer.byteLength(JSON.stringify({ answers, note: draft.note })) > 40_000
  ) {
    throw new Error(
      "Combined answers and notes exceed 40,000 UTF-8 bytes; shorten them before submitting"
    );
  }

  return answers;
};

export const transition = (
  item: Interaction,
  action: Action,
  now = new Date().toISOString()
): Interaction => {
  const next = structuredClone(item);
  const { draft } = next;

  switch (action.type) {
    case "select":
    case "custom":
    case "toggle_custom":
    case "note": {
      if (!draft || next.cancelled) {
        throw new Error("No editable draft; reopen first");
      }

      if (
        action.type === "note" &&
        (action.question === undefined || action.question === "")
      ) {
        if (action.text.length > MAX_NOTE) {
          throw new Error(`Note limit: ${MAX_NOTE} characters`);
        }

        draft.note = action.text;
        break;
      }

      const q = next.request.questions.find(
        (question) => question.id === action.question
      );

      if (!q) {
        throw new Error("Unknown question");
      }

      const a = draft.answers[q.id];

      if (!a) {
        throw new Error(`Missing draft answer: ${q.id}`);
      }

      if (action.type === "select") {
        if (q.options?.some((o) => o.id === action.option) !== true) {
          throw new Error("Unknown option");
        }

        if (q.multi_select === true) {
          a.selected = a.selected.includes(action.option)
            ? a.selected.filter((id) => id !== action.option)
            : [...a.selected, action.option];
        } else {
          a.selected = [action.option];
          a.custom_selected = false;
        }
      } else if (action.type === "custom") {
        if (action.text.length > MAX_TEXT) {
          throw new Error(`Answer limit: ${MAX_TEXT} characters`);
        }

        a.custom = action.text;
        a.custom_selected = true;

        if (q.multi_select !== true) {
          a.selected = [];
        }
      } else if (action.type === "toggle_custom") {
        a.custom_selected = !a.custom_selected;

        if (q.multi_select !== true && a.custom_selected) {
          a.selected = [];
        }
      } else {
        if (action.text.length > MAX_NOTE) {
          throw new Error(`Note limit: ${MAX_NOTE} characters`);
        }

        if (action.option !== undefined && action.option !== "") {
          if (q.options?.some((o) => o.id === action.option) !== true) {
            throw new Error("Unknown option");
          }

          a.notes[action.option] = action.text;
        } else {
          a.custom_note = action.text;
        }
      }

      break;
    }

    case "submit": {
      if (!draft || next.cancelled) {
        throw new Error("No editable draft");
      }

      const submission: Submission = {
        revision: next.submissions.length + 1,
        timestamp: now,
        initiated_by: draft.initiated_by,
        mode: draft.mode,
        answers: collectAnswers(next),
        note: draft.note,
      };

      if (draft.reason !== undefined && draft.reason !== "") {
        submission.reason = draft.reason;
      }

      if (draft.tool_call_id !== undefined && draft.tool_call_id !== "") {
        submission.tool_call_id = draft.tool_call_id;
      }

      next.submissions.push(submission);
      delete next.draft;
      break;
    }

    case "reopen": {
      if (draft) {
        throw new Error(
          "An editable draft already exists; finish or cancel it before requesting a revision"
        );
      }

      const base = next.submissions.at(-1);

      if (!base) {
        throw new Error(
          next.cancelled
            ? "This request was cancelled before any answer; author a new request instead"
            : "Nothing has been submitted yet; wait for an answer before revising"
        );
      }

      if (base.revision !== action.base) {
        throw new Error(
          `Stale base revision; the latest submission is revision ${base.revision}`
        );
      }

      next.draft = {
        initiated_by: action.initiated_by,
        mode: action.mode ?? base.mode,

        note: base.note,
        answers: Object.fromEntries(
          next.request.questions.map((q) => {
            const a = base.answers[q.id];

            if (!a) {
              throw new Error(`Missing submitted answer: ${q.id}`);
            }

            return [
              q.id,
              {
                selected: a.selections.map((s) => s.option_id),
                notes: Object.fromEntries(
                  (q.options ?? []).map((o) => [
                    o.id,
                    a.selections.find((s) => s.option_id === o.id)?.note ?? "",
                  ])
                ),
                custom_selected: !!a.custom,
                custom: a.custom?.text ?? "",
                custom_note: a.custom?.note ?? "",
              },
            ];
          })
        ),
      };

      if (action.reason !== undefined && action.reason !== "") {
        next.draft.reason = action.reason;
      }

      if (action.tool_call_id !== undefined && action.tool_call_id !== "") {
        next.draft.tool_call_id = action.tool_call_id;
      }

      next.cancelled = false;
      break;
    }

    case "cancel": {
      next.cancelled = true;
      delete next.draft;
      break;
    }

    case "sent": {
      const submission = next.submissions.find(
        (s) => s.revision === action.revision
      );

      if (!submission) {
        throw new Error("Unknown submission revision");
      }

      submission.sent_at = now;
      break;
    }
  }

  next.updated_at = now;

  return next;
};

export const revisedSubmission = (item: Interaction): Submission | undefined =>
  item.draft ? item.submissions.at(-1) : undefined;

export const awaitingUser = (item: Interaction): boolean =>
  !item.cancelled &&
  (!!item.draft ||
    item.submissions.some((s) => s.sent_at === undefined || s.sent_at === ""));
