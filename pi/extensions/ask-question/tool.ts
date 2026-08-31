import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { AnswerEntry, AskQuestionFlowResult, Question, QuestionOption } from "./questions.js";

const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 5;
const MAX_PLACEHOLDER = 120;
const MAX_HEADER = 64;
const MAX_QUESTION = 1000;
const MAX_OPTION_LABEL = 256;
const MAX_OPTION_DETAILS = 2000;

const AskQuestionOptionSchema = Type.Object(
  {
    details: Type.Optional(
      Type.String({
        description: "Optional rationale shown on demand. Explain suggested defaults here.",
        maxLength: MAX_OPTION_DETAILS,
      }),
    ),
    label: Type.String({
      description: "User-visible option label. Add '(Suggested)' for likely defaults.",
      maxLength: MAX_OPTION_LABEL,
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

const AskQuestionQuestionSchema = Type.Object(
  {
    header: Type.String({
      description: "Short tab header",
      maxLength: MAX_HEADER,
      minLength: 1,
    }),
    multiSelect: Type.Optional(
      Type.Boolean({
        description: "Allow choosing several options. Defaults to one choice per question.",
      }),
    ),
    options: Type.Array(AskQuestionOptionSchema, {
      description:
        "Answer options. Do not include an 'Other' option; the UI appends a free-text Other automatically.",
      maxItems: MAX_OPTIONS,
      minItems: MIN_OPTIONS,
    }),
    placeholder: Type.Optional(
      Type.String({
        description: "Optional placeholder/helper text",
        maxLength: MAX_PLACEHOLDER,
      }),
    ),
    question: Type.String({
      description: "Full question prompt",
      maxLength: MAX_QUESTION,
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export const AskQuestionParametersSchema = Type.Object(
  {
    questions: Type.Array(AskQuestionQuestionSchema, {
      description: `Questions to ask in this call (${MIN_QUESTIONS}..${MAX_QUESTIONS}).`,
      maxItems: MAX_QUESTIONS,
      minItems: MIN_QUESTIONS,
    }),
  },
  { additionalProperties: false },
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

const sanitizeDisplayText = (value: string): string =>
  Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x09 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
      ? ""
      : char;
  }).join("");

export const parseQuestionsFromParameters = (params: AskQuestionParameters): Question[] => {
  const questions: Question[] = [];

  for (const questionValue of params.questions) {
    const header = sanitizeDisplayText(questionValue.header).trim();
    const question = sanitizeDisplayText(questionValue.question).trim();
    const placeholder =
      questionValue.placeholder === undefined
        ? undefined
        : sanitizeDisplayText(questionValue.placeholder);
    if (header === "" || question === "") {
      throw new Error("Question headers and prompts must not be blank");
    }

    const seenOptionLabels = new Set<string>();
    const options: QuestionOption[] = questionValue.options.map((optionValue) => {
      const details =
        optionValue.details === undefined ? undefined : sanitizeDisplayText(optionValue.details);
      const label = sanitizeDisplayText(optionValue.label).trim();
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
    });

    options.push({
      kind: "other",
      label: "Other",
    });

    questions.push({
      header,
      multiSelect: questionValue.multiSelect ?? false,
      options,
      placeholder,
      question,
    });
  }

  return questions;
};

export const buildSummaryContent = (questions: Question[], answers: AnswerEntry[]): string => {
  const lines: string[] = ["User answered:"];

  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    lines.push(
      `- [${question.header}] ${question.question} -> ${answer
        .map((selection) => selection.label)
        .join(", ")}`,
    );
    const notedSelections = answer.filter(({ note }) => note !== undefined && note.length > 0);
    if (notedSelections.length > 0) {
      lines.push("  notes:");
      for (const selection of notedSelections) {
        lines.push(`  - ${selection.label}: ${selection.note}`);
      }
    }
  }

  return lines.join("\n");
};

interface AskQuestionSuccessResult {
  content: { text: string; type: "text" }[];
  details: AskQuestionSuccessDetails;
}

interface AskQuestionCancelledResult {
  content: { text: string; type: "text" }[];
  details: AskQuestionCancelledDetails;
  terminate: true;
}

export const buildSuccessToolResult = (
  questions: Question[],
  flow: Extract<AskQuestionFlowResult, { cancelled: false }>,
): AskQuestionSuccessResult => {
  const details: AskQuestionSuccessDetails = {
    answers: flow.answers,
    cancelled: false,
  };

  return {
    content: [
      {
        text: truncateHead(buildSummaryContent(questions, flow.answers)).content,
        type: "text",
      },
    ],
    details,
  };
};

export const buildCancelledToolResult = (
  reason: AskQuestionCancelledDetails["reason"],
): AskQuestionCancelledResult => {
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
  pi: Pick<ExtensionAPI, "events">,
  params: AskQuestionParameters,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) => {
  const questions = parseQuestionsFromParameters(params);

  if (ctx.mode !== "tui") {
    throw new Error("ask_question requires interactive UI");
  }

  // Pi's generic prompt events do not identify the owning extension, so Herdr
  // needs this ask-specific signal to distinguish questions from Side UI.
  pi.events.emit("herdr:blocked", {
    active: true,
    label: "Waiting for answers",
  });

  try {
    const { runAskQuestionPrompt } = await import("./dialog/controller.js");
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
