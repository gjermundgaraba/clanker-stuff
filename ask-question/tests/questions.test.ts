import { describe, expect, it } from "vitest";

import {
  buildAnswerEntry,
  createQuestionSessions,
  isQuestionComplete,
} from "../questions.js";
import type { Question } from "../questions.js";

describe("ask-question state", () => {
  it("requires text when Other is selected", () => {
    const question: Question = {
      header: "Plan",
      options: [
        { kind: "option", label: "Standard" },
        { kind: "other", label: "Other" },
      ],
      question: "Which plan do you want?",
      type: "single_select",
    };
    const [session] = createQuestionSessions([question]);

    session.state.selectedIndex = 1;
    expect(isQuestionComplete(question, session.state)).toBeFalsy();

    session.state.textByOptionIndex[1] = "Enterprise";
    expect(isQuestionComplete(question, session.state)).toBeTruthy();
    expect(buildAnswerEntry(question, session.state)).toStrictEqual({
      answer: { label: "Other", note: "Enterprise" },
      type: "single_select",
    });
  });
});
