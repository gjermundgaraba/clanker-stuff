import { describe, expect, it } from "vite-plus/test";

import { buildAnswerEntry, createQuestionSessions, isQuestionComplete } from "../questions.js";
import type { Question } from "../questions.js";

describe("ask-question state", () => {
  it("requires text when Other is selected", () => {
    const question: Question = {
      header: "Plan",
      multiSelect: false,
      options: [
        { kind: "option", label: "Standard" },
        { kind: "other", label: "Other" },
      ],
      question: "Which plan do you want?",
    };
    const [session] = createQuestionSessions([question]);

    session.state.selectedIndexes.add(1);
    expect(isQuestionComplete(question, session.state)).toBeFalsy();

    session.state.textByOptionIndex[1] = "Enterprise";
    expect(isQuestionComplete(question, session.state)).toBeTruthy();
    expect(buildAnswerEntry(question, session.state)).toStrictEqual([
      { label: "Other", note: "Enterprise" },
    ]);
  });
});
