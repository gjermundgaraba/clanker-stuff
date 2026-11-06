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

const FieldsSchema = Type.Object(
  {
    selected: Type.Array(Id, { uniqueItems: true }),
    custom_selected: Type.Boolean(),
    custom: Type.String({ maxLength: MAX_TEXT }),
    notes: record(Type.String({ maxLength: MAX_NOTE })),
    custom_note: Type.String({ maxLength: MAX_NOTE }),
  },
  { additionalProperties: false }
);

const DraftSchema = record(FieldsSchema);

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

export const AnswersSchema = record(AnswerSchema);

export const RequestRecordSchema = Type.Object(
  {
    id: Id,
    request: QuestionnaireSchema,
  },
  { additionalProperties: false }
);

export const StateRecordSchema = Type.Object(
  {
    id: Id,
    updated_at: Type.String(),
    draft: Type.Optional(DraftSchema),
  },
  { additionalProperties: false }
);

export type RequestRecord = Static<typeof RequestRecordSchema>;

type StateRecord = Static<typeof StateRecordSchema>;

/** A questionnaire is open, and answerable, exactly while it has a draft. */
export type Interaction = RequestRecord & StateRecord;

export type Draft = Static<typeof DraftSchema>;

export type Fields = Static<typeof FieldsSchema>;

export type Answer = Static<typeof AnswerSchema>;

export type Answers = Static<typeof AnswersSchema>;

export type Action =
  | { type: "select"; question: string; option: string }
  | { type: "custom"; question: string; text: string }
  | { type: "toggle_custom"; question: string }
  | { type: "note"; question: string; option?: string; text: string }
  | { type: "submit" }
  | { type: "dismiss" }
  | { type: "restore"; draft: Draft };

export const createInteraction = (
  id: string,
  input: unknown,
  now = new Date().toISOString()
): Interaction => {
  const request = validateQuestionnaire(input);

  return {
    id,
    request,
    updated_at: now,
    draft: Object.fromEntries(
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
  };
};

export const answered = (a: Fields | undefined): boolean =>
  a !== undefined &&
  (a.selected.length > 0 || a.custom_selected) &&
  (!a.custom_selected || !!displayText(a.custom).trim());

export const draftAnswer = (item: Interaction, q: Question): Answer => {
  const answer: Answer = {
    question: q.question,
    header: q.header,
    selections: [],
  };

  const a = item.draft?.[q.id];

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

/** Validates a complete draft and snapshots its selected answers and notes. */
export const collectAnswers = (item: Interaction): Answers => {
  const { draft } = item;

  if (!draft) {
    throw new Error("This questionnaire is no longer open");
  }

  const answers: Answers = {};

  for (const q of item.request.questions) {
    const a = draft[q.id];

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

  if (Buffer.byteLength(JSON.stringify(answers)) > 40_000) {
    throw new Error(
      "Combined answers and notes exceed 40,000 UTF-8 bytes; shorten them before submitting"
    );
  }

  return answers;
};

const edit = (
  q: Question,
  a: Fields,
  action: Extract<Action, { question: string }>
): void => {
  switch (action.type) {
    case "select": {
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

      break;
    }

    case "custom": {
      if (action.text.length > MAX_TEXT) {
        throw new Error(`Answer limit: ${MAX_TEXT} characters`);
      }

      a.custom = action.text;
      a.custom_selected = true;

      if (q.multi_select !== true) {
        a.selected = [];
      }

      break;
    }

    case "toggle_custom": {
      a.custom_selected = !a.custom_selected;

      if (q.multi_select !== true && a.custom_selected) {
        a.selected = [];
      }

      break;
    }

    case "note": {
      if (action.text.length > MAX_NOTE) {
        throw new Error(`Note limit: ${MAX_NOTE} characters`);
      }

      if (action.option === undefined) {
        a.custom_note = action.text;
      } else if (q.options?.some((o) => o.id === action.option) === true) {
        a.notes[action.option] = action.text;
      } else {
        throw new Error("Unknown option");
      }

      break;
    }
  }
};

export const transition = (
  item: Interaction,
  action: Action,
  now = new Date().toISOString()
): Interaction => {
  const next = structuredClone(item);

  if (action.type === "restore") {
    next.draft = structuredClone(action.draft);
  } else {
    const { draft } = next;

    if (!draft) {
      throw new Error("This questionnaire is no longer open");
    }

    if (action.type === "submit") {
      collectAnswers(next);
      delete next.draft;
    } else if (action.type === "dismiss") {
      delete next.draft;
    } else {
      const q = next.request.questions.find(
        (question) => question.id === action.question
      );

      const a = q && draft[q.id];

      if (!q || !a) {
        throw new Error(`Unknown question: ${action.question}`);
      }

      edit(q, a, action);
    }
  }

  next.updated_at = now;

  return next;
};
