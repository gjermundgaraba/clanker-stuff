import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import {
  AskQuestionParametersSchema,
  buildSummaryContent,
  parseQuestionsFromParameters,
} from "../contract.js";
import askQuestion from "../index.js";

interface QuestionBranchSchema {
  additionalProperties?: boolean;
  properties?: {
    type?: {
      description?: string;
      type?: string;
      enum?: string[];
    };
    options?: unknown;
  };
}

const getOptionQuestionTypeSchema = (): {
  description?: string;
  type?: string;
  enum?: string[];
} => {
  const schema = AskQuestionParametersSchema as unknown as {
    properties?: {
      questions?: {
        items?: {
          anyOf?: QuestionBranchSchema[];
        };
      };
    };
  };

  const branches = schema.properties?.questions?.items?.anyOf;
  expect(branches).toBeDefined();

  const optionQuestionBranch = branches?.find(
    (branch) => branch.properties?.options !== undefined
  );

  expect(optionQuestionBranch).toBeDefined();
  return optionQuestionBranch?.properties?.type ?? {};
};

describe("ask-question contract", () => {
  it("emits a Google-safe string enum for option question types", () => {
    expect(getOptionQuestionTypeSchema()).toMatchObject({
      description:
        "Question type. Prefer single_select or multi_select; use free_text only when multiple options doesn't make sense.",
      enum: ["single_select", "multi_select"],
      type: "string",
    });
  });

  it("keeps the public schema strict", () => {
    const host = createExtensionHost(askQuestion);
    const definition = host
      .getRegisteredTools()
      .get("ask_question")?.definition;
    const schema = AskQuestionParametersSchema as unknown as {
      additionalProperties?: boolean;
      properties?: {
        questions?: {
          items?: {
            anyOf?: QuestionBranchSchema[];
          };
        };
      };
    };

    expect(definition).toBeDefined();
    expect(schema.additionalProperties).toBeFalsy();
    expect(
      schema.properties?.questions?.items?.anyOf?.every(
        (branch) => branch.additionalProperties === false
      )
    ).toBeTruthy();
  });

  it("rejects invalid input with a generic schema error", () => {
    expect(() =>
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            question: "Which plan do you want?",
            type: "single_select",
          },
        ],
      })
    ).toThrow("Invalid ask_question input");
  });

  it("rejects duplicate option labels", () => {
    expect(() =>
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            options: [{ label: "Alpha" }, { label: "Alpha" }],
            question: "Choose one",
            type: "single_select",
          },
        ],
      })
    ).toThrow("Duplicate option label: Alpha");
  });

  it.each([
    {
      firstLabel: "Alpha",
      header: "Plan",
      question: "Choose one",
      type: "single_select",
    },
    {
      firstLabel: "Feature A",
      header: "Features",
      question: "Choose any",
      type: "multi_select",
    },
  ] as const)(
    "rejects explicit Other for $type questions",
    ({ type, header, question, firstLabel }) => {
      expect(() =>
        parseQuestionsFromParameters({
          questions: [
            {
              header,
              options: [{ label: firstLabel }, { label: "Other" }],
              question,
              type,
            },
          ],
        })
      ).toThrow(
        "Do not include an 'Other' option; the UI provides it automatically"
      );
    }
  );

  it("appends an implicit Other option and preserves details", () => {
    expect(
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            options: [
              {
                details: "Best default for most teams.",
                label: "Fast (Suggested)",
              },
            ],
            placeholder: "Pick one",
            question: "Which plan do you want?",
            type: "single_select",
          },
        ],
      })
    ).toStrictEqual([
      {
        header: "Plan",
        options: [
          {
            details: "Best default for most teams.",
            kind: "option",
            label: "Fast (Suggested)",
          },
          {
            kind: "other",
            label: "Other",
          },
        ],
        placeholder: "Pick one",
        question: "Which plan do you want?",
        type: "single_select",
      },
    ]);
  });

  it("builds summaries from aligned answers", () => {
    const questions = parseQuestionsFromParameters({
      questions: [
        {
          header: "Plan",
          options: [{ label: "Alpha" }, { label: "Beta" }],
          question: "Which plan do you want?",
          type: "single_select",
        },
        {
          header: "Notes",
          question: "Anything else to add?",
          type: "free_text",
        },
      ],
    });

    expect(
      buildSummaryContent(questions, [
        {
          answer: { label: "Alpha" },
          type: "single_select",
        },
        {
          answer: { text: "Need examples" },
          type: "free_text",
        },
      ])
    ).toBe(
      [
        "User answered:",
        "- [Plan] Which plan do you want? -> Alpha",
        "- [Notes] Anything else to add? -> Need examples",
      ].join("\n")
    );
  });
});
