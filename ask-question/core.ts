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

export type CompletedQuestionState =
  | {
      type: "single_select";
      question: SingleSelectQuestion;
      state: QuestionState & { selectedIndex: number };
    }
  | {
      type: "multi_select";
      question: MultiSelectQuestion;
      state: QuestionState;
      selectedIndexes: number[];
    }
  | {
      type: "free_text";
      question: FreeTextQuestion;
      state: QuestionState & { freeText: string };
    };

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

const hasCompletedFreeTextState = (
  state: QuestionState
): state is QuestionState & { freeText: string } =>
  typeof state.freeText === "string" && state.freeText.length > 0;

const hasSelectedIndexState = (
  state: QuestionState
): state is QuestionState & { selectedIndex: number } =>
  typeof state.selectedIndex === "number";

const getCompletedQuestionState = (
  question: Question,
  state: QuestionState
): CompletedQuestionState | undefined => {
  if (question.type === "free_text") {
    if (!hasCompletedFreeTextState(state)) {
      return undefined;
    }

    return { question, state, type: "free_text" };
  }

  if (question.type === "single_select") {
    if (!hasSelectedIndexState(state)) {
      return undefined;
    }

    if (!isOtherOption(question.options[state.selectedIndex])) {
      return { question, state, type: "single_select" };
    }

    const text = state.textByOptionIndex[state.selectedIndex];
    return typeof text === "string" && text.length > 0
      ? { question, state, type: "single_select" }
      : undefined;
  }

  const selectedIndexes = getSelectedOptionIndexes(question, state);
  if (selectedIndexes.length === 0) {
    return undefined;
  }

  const allSelectedOptionsComplete = selectedIndexes.every((selectedIndex) => {
    if (!isOtherOption(question.options[selectedIndex])) {
      return true;
    }

    const text = state.textByOptionIndex[selectedIndex];
    return typeof text === "string" && text.length > 0;
  });

  return allSelectedOptionsComplete
    ? { question, selectedIndexes, state, type: "multi_select" }
    : undefined;
};

export const isQuestionComplete = (
  question: Question,
  state: QuestionState
): boolean => getCompletedQuestionState(question, state) !== undefined;

export const buildAnswerEntry = (
  question: Question,
  state: QuestionState
): AnswerEntry | undefined => {
  const completed = getCompletedQuestionState(question, state);
  if (!completed) {
    return undefined;
  }

  if (completed.type === "single_select") {
    const { question: completedQuestion, state: completedState } = completed;
    const option = completedQuestion.options[completedState.selectedIndex];
    const note = completedState.textByOptionIndex[completedState.selectedIndex];

    return {
      answer:
        typeof note === "string" && note !== ""
          ? {
              label: option.label,
              note,
            }
          : {
              label: option.label,
            },
      type: "single_select",
    };
  }

  if (completed.type === "multi_select") {
    const {
      question: completedQuestion,
      state: completedState,
      selectedIndexes,
    } = completed;
    return {
      answer: selectedIndexes.map((index) => {
        const option = completedQuestion.options[index];
        const note = completedState.textByOptionIndex[index];

        return typeof note === "string" && note !== ""
          ? {
              label: option.label,
              note,
            }
          : {
              label: option.label,
            };
      }),
      type: "multi_select",
    };
  }

  return {
    answer: { text: completed.state.freeText },
    type: "free_text",
  };
};

export const answerEntryToText = (entry: AnswerEntry): string => {
  if (entry.type === "free_text") {
    return entry.answer.text;
  }

  if (entry.type === "single_select") {
    const noteText =
      typeof entry.answer.note === "string" && entry.answer.note !== ""
        ? ` (note: ${entry.answer.note})`
        : "";
    return `${entry.answer.label}${noteText}`;
  }

  return entry.answer
    .map((selection) => {
      const noteText =
        typeof selection.note === "string" && selection.note !== ""
          ? ` (note: ${selection.note})`
          : "";
      return `${selection.label}${noteText}`;
    })
    .join(", ");
};

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
