export interface ListedQuestionOption {
  kind: "option";
  label: string;
  details?: string;
}

export interface OtherQuestionOption {
  kind: "other";
  label: "Other";
  details?: never;
}

export type QuestionOption = ListedQuestionOption | OtherQuestionOption;

export interface BaseOptionQuestion {
  header: string;
  question: string;
  placeholder?: string;
  options: QuestionOption[];
}

export interface SingleSelectQuestion extends BaseOptionQuestion {
  type: "single_select";
}

export interface MultiSelectQuestion extends BaseOptionQuestion {
  type: "multi_select";
}

export type OptionQuestion = SingleSelectQuestion | MultiSelectQuestion;

export interface FreeTextQuestion {
  header: string;
  question: string;
  type: "free_text";
  placeholder?: string;
  options?: never;
}

export type Question = OptionQuestion | FreeTextQuestion;

export type AnswerEntry =
  | {
      type: "single_select";
      answer: {
        label: string;
        note?: string;
      };
    }
  | {
      type: "multi_select";
      answer: {
        label: string;
        note?: string;
      }[];
    }
  | {
      type: "free_text";
      answer: {
        text: string;
      };
    };

export interface QuestionState {
  cursor: number;
  selectedIndex?: number;
  selectedIndexes: Set<number>;
  textByOptionIndex: (string | undefined)[];
  freeText?: string;
}

export interface QuestionSession {
  question: Question;
  state: QuestionState;
}

export type AskQuestionFlowResult =
  | {
      cancelled: false;
      answers: AnswerEntry[];
    }
  | {
      cancelled: true;
      reason: "user_cancelled" | "external_aborted";
    };

export const isOtherOption = (
  option: QuestionOption | undefined
): option is OtherQuestionOption => option?.kind === "other";

export const isOptionSelected = (
  question: Question,
  state: QuestionState,
  index: number
): boolean => {
  if (question.type === "free_text") {
    return false;
  }

  if (question.type === "single_select") {
    return state.selectedIndex === index;
  }

  return state.selectedIndexes.has(index);
};

const getSelectedOptionIndexes = (
  question: Question,
  state: QuestionState
): number[] => {
  if (question.type === "free_text") {
    return [];
  }

  if (question.type === "single_select") {
    return typeof state.selectedIndex === "number" ? [state.selectedIndex] : [];
  }

  const selectedIndexes: number[] = [];
  for (let index = 0; index < question.options.length; index += 1) {
    if (state.selectedIndexes.has(index)) {
      selectedIndexes.push(index);
    }
  }

  return selectedIndexes;
};

export const createQuestionSessions = (
  questions: Question[]
): QuestionSession[] =>
  questions.map((question) => ({
    question,
    state: {
      cursor: 0,
      selectedIndexes: new Set<number>(),
      textByOptionIndex:
        question.type === "free_text"
          ? []
          : Array.from(
              { length: question.options.length },
              (): string | undefined => undefined
            ),
    },
  }));

export const buildAnswerEntry = (
  question: Question,
  state: QuestionState
): AnswerEntry | undefined => {
  if (question.type === "free_text") {
    return typeof state.freeText === "string" && state.freeText.length > 0
      ? {
          answer: { text: state.freeText },
          type: "free_text",
        }
      : undefined;
  }

  const selectedIndexes = getSelectedOptionIndexes(question, state);
  if (
    selectedIndexes.length === 0 ||
    selectedIndexes.some((index) => {
      const text = state.textByOptionIndex[index];
      return (
        isOtherOption(question.options[index]) &&
        (text === undefined || text.length === 0)
      );
    })
  ) {
    return undefined;
  }
  const answers = selectedIndexes.map((index) => {
    const option = question.options[index];
    const note = state.textByOptionIndex[index];
    return note !== undefined && note.length > 0
      ? {
          label: option.label,
          note,
        }
      : {
          label: option.label,
        };
  });
  if (question.type === "single_select") {
    return {
      answer: answers[0],
      type: "single_select",
    };
  }

  return {
    answer: answers,
    type: "multi_select",
  };
};

export const isQuestionComplete = (
  question: Question,
  state: QuestionState
): boolean => buildAnswerEntry(question, state) !== undefined;

export const answerEntryToText = (entry: AnswerEntry): string => {
  if (entry.type === "free_text") {
    return entry.answer.text;
  }

  if (entry.type === "single_select") {
    const noteText =
      entry.answer.note !== undefined && entry.answer.note !== ""
        ? ` (note: ${entry.answer.note})`
        : "";
    return `${entry.answer.label}${noteText}`;
  }

  return entry.answer
    .map((selection) => {
      const noteText =
        selection.note !== undefined && selection.note !== ""
          ? ` (note: ${selection.note})`
          : "";
      return `${selection.label}${noteText}`;
    })
    .join(", ");
};

export const allQuestionsComplete = (sessions: QuestionSession[]): boolean =>
  sessions.every(({ question, state }) => isQuestionComplete(question, state));

export const missingQuestionHeaders = (sessions: QuestionSession[]): string[] =>
  sessions.flatMap(({ question, state }) =>
    isQuestionComplete(question, state) ? [] : [question.header]
  );

export const buildSuccessFlowResult = (
  sessions: QuestionSession[]
): Extract<AskQuestionFlowResult, { cancelled: false }> | undefined => {
  const answers: AnswerEntry[] = [];
  for (const { question, state } of sessions) {
    const answer = buildAnswerEntry(question, state);
    if (answer === undefined) {
      return undefined;
    }
    answers.push(answer);
  }

  return { answers, cancelled: false };
};
