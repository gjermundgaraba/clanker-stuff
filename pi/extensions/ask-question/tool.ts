import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { runAskQuestionPrompt } from "./dialog/controller.js";
import type {
  AnswerEntry,
  AskQuestionFlowResult,
  Question,
  QuestionOption,
} from "./questions.js";

const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 5;
const MAX_PLACEHOLDER = 120;

const QUESTION_TYPE_DESCRIPTION =
  "Question type. Prefer single_select or multi_select; use free_text only when multiple options doesn't make sense.";

const AskQuestionOptionSchema = Type.Object(
  {
    details: Type.Optional(
      Type.String({
        description:
          "Optional rationale shown on demand. Explain suggested defaults here.",
      })
    ),
    label: Type.String({
      description:
        "User-visible option label. Add '(Suggested)' for likely defaults.",
      minLength: 1,
    }),
  },
  { additionalProperties: false }
);

const AskQuestionBaseQuestionProperties = {
  header: Type.String({
    description: "Short tab header",
    minLength: 1,
  }),
  placeholder: Type.Optional(
    Type.String({
      description: "Optional placeholder/helper text",
      maxLength: MAX_PLACEHOLDER,
    })
  ),
  question: Type.String({
    description: "Full question prompt",
    minLength: 1,
  }),
};

const AskQuestionQuestionSchema = Type.Object(
  {
    ...AskQuestionBaseQuestionProperties,
    options: Type.Optional(
      Type.Array(AskQuestionOptionSchema, {
        description: "Options for single_select and multi_select questions.",
        maxItems: MAX_OPTIONS,
        minItems: MIN_OPTIONS,
      })
    ),
    type: StringEnum(["free_text", "single_select", "multi_select"] as const, {
      description: QUESTION_TYPE_DESCRIPTION,
    }),
  },
  { additionalProperties: false }
);

export const AskQuestionParametersSchema = Type.Object(
  {
    questions: Type.Array(AskQuestionQuestionSchema, {
      description: `Questions to ask in this call (${MIN_QUESTIONS}..${MAX_QUESTIONS}).`,
      maxItems: MAX_QUESTIONS,
      minItems: MIN_QUESTIONS,
    }),
  },
  { additionalProperties: false }
);

export type AskQuestionParameters = Static<typeof AskQuestionParametersSchema>;

export interface AskQuestionSuccessDetails {
  cancelled: false;
  answers: AnswerEntry[];
}

export interface AskQuestionCancelledDetails {
  cancelled: true;
  abortedRun: true;
  reason: Extract<AskQuestionFlowResult, { cancelled: true }>["reason"];
}

const EXPLICIT_OTHER_OPTION_ERROR =
  "Do not include an 'Other' option; the UI provides it automatically";

export const parseQuestionsFromParameters = (params: unknown): Question[] => {
  if (!Value.Check(AskQuestionParametersSchema, params)) {
    throw new Error("Invalid ask_question input");
  }

  const questions: Question[] = [];

  for (const questionValue of params.questions) {
    const { header, placeholder, question } = questionValue;

    if (questionValue.type === "free_text") {
      if (questionValue.options !== undefined) {
        throw new Error("Invalid ask_question input");
      }
      questions.push({
        header,
        placeholder,
        question,
        type: questionValue.type,
      });
      continue;
    }
    if (questionValue.options === undefined) {
      throw new Error("Invalid ask_question input");
    }

    const seenOptionLabels = new Set<string>();
    const options: QuestionOption[] = questionValue.options.map(
      (optionValue) => {
        const { details } = optionValue;
        const label = optionValue.label.trim();
        const normalizedLabel = label.toLowerCase();
        if (label === "") {
          throw new Error("Option labels must not be blank");
        }
        if (normalizedLabel === "other") {
          throw new Error(EXPLICIT_OTHER_OPTION_ERROR);
        }
        if (seenOptionLabels.has(normalizedLabel)) {
          throw new Error(`Duplicate option label: ${label}`);
        }

        seenOptionLabels.add(normalizedLabel);
        return {
          details,
          kind: "option",
          label,
        };
      }
    );

    options.push({
      kind: "other",
      label: "Other",
    });

    questions.push({
      header,
      options,
      placeholder,
      question,
      type: questionValue.type,
    });
  }

  return questions;
};

export const buildSummaryContent = (
  questions: Question[],
  answers: AnswerEntry[]
): string => {
  const lines: string[] = ["User answered:"];

  for (const [index, question] of questions.entries()) {
    const entry = answers[index];

    if (entry.type === "single_select") {
      lines.push(
        `- [${question.header}] ${question.question} -> ${entry.answer.label}`
      );
      if (typeof entry.answer.note === "string" && entry.answer.note !== "") {
        lines.push(`  note: ${entry.answer.note}`);
      }
      continue;
    }

    if (entry.type === "multi_select") {
      lines.push(
        `- [${question.header}] ${question.question} -> ${entry.answer.map((selection) => selection.label).join(", ")}`
      );
      const notedSelections = entry.answer.filter(
        (selection) =>
          typeof selection.note === "string" && selection.note !== ""
      );
      if (notedSelections.length > 0) {
        lines.push("  notes:");
        for (const selection of notedSelections) {
          lines.push(`  - ${selection.label}: ${selection.note}`);
        }
      }
      continue;
    }

    lines.push(
      `- [${question.header}] ${question.question} -> ${entry.answer.text}`
    );
  }

  return lines.join("\n");
};

export const buildSuccessToolResult = (
  questions: Question[],
  flow: Extract<AskQuestionFlowResult, { cancelled: false }>
): {
  content: { type: "text"; text: string }[];
  details: AskQuestionSuccessDetails;
} => {
  const details: AskQuestionSuccessDetails = {
    answers: flow.answers,
    cancelled: false,
  };

  return {
    content: [
      {
        text: buildSummaryContent(questions, flow.answers),
        type: "text",
      },
    ],
    details,
  };
};

export const buildCancelledToolResult = (
  reason: AskQuestionCancelledDetails["reason"]
): {
  content: { type: "text"; text: string }[];
  details: AskQuestionCancelledDetails;
  terminate: true;
} => {
  const text =
    reason === "external_aborted"
      ? "ask-question was cancelled because the run was aborted."
      : "User cancelled ask-question. Aborting current run.";

  return {
    content: [
      {
        text,
        type: "text",
      },
    ],
    details: {
      abortedRun: true,
      cancelled: true,
      reason,
    },
    terminate: true,
  };
};

export const executeAskQuestion = async (
  pi: ExtensionAPI,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext
) => {
  const questions = parseQuestionsFromParameters(params);

  if (ctx.mode !== "tui") {
    throw new Error("ask_question requires interactive UI");
  }

  // https://github.com/ogulcancelik/herdr/blob/v0.7.5/src/integration/assets/pi/herdr-agent-state.ts#L230-L246
  pi.events.emit("herdr:blocked", {
    active: true,
    label: "Waiting for answers",
  });

  try {
    const flow = await runAskQuestionPrompt(ctx, questions, signal);

    if (flow.cancelled) {
      ctx.abort();
      return buildCancelledToolResult(flow.reason);
    }

    return buildSuccessToolResult(questions, flow);
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
};
