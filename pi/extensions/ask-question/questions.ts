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

export interface Question {
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  placeholder?: string;
  question: string;
}

export type AnswerEntry = {
  label: string;
  note?: string;
}[];

export interface QuestionState {
  cursor: number;
  selectedIndexes: Set<number>;
  textByOptionIndex: (string | undefined)[];
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

export const createQuestionSessions = (
  questions: Question[]
): QuestionSession[] =>
  questions.map((question) => ({
    question,
    state: {
      cursor: 0,
      selectedIndexes: new Set<number>(),
      textByOptionIndex: question.options.map(
        (): string | undefined => undefined
      ),
    },
  }));

export const buildAnswerEntry = (
  question: Question,
  state: QuestionState
): AnswerEntry | undefined => {
  const selectedIndexes = [...state.selectedIndexes].toSorted((a, b) => a - b);
  if (
    selectedIndexes.length === 0 ||
    selectedIndexes.some(
      (index) =>
        isOtherOption(question.options[index]) &&
        !state.textByOptionIndex[index]
    )
  ) {
    return undefined;
  }
  return selectedIndexes.map((index) => {
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
};

export const isQuestionComplete = (
  question: Question,
  state: QuestionState
): boolean => buildAnswerEntry(question, state) !== undefined;

export const answerEntryToText = (entry: AnswerEntry): string =>
  entry
    .map((selection) =>
      selection.note
        ? `${selection.label} (note: ${selection.note})`
        : selection.label
    )
    .join(", ");

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
