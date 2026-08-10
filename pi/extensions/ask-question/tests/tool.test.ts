import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import askQuestion from "../index.js";
import {
  AskQuestionParametersSchema,
  buildSummaryContent,
  parseQuestionsFromParameters,
} from "../tool.js";
import {
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_TAB,
  executeTool,
  expectCancelledResult,
  expectSuccessResult,
} from "./helpers.js";

const singleQuestionParams = {
  questions: [
    {
      header: "Plan",
      options: [{ label: "Yes" }, { label: "No" }],
      question: "Which plan do you want?",
      type: "single_select" as const,
    },
  ],
};

const questionSchema = AskQuestionParametersSchema.properties.questions.items;

describe("ask-question contract", () => {
  it("emits one Google-safe string enum for every question type", () => {
    expect(questionSchema.properties.type).toMatchObject({
      description:
        "Question type. Prefer single_select or multi_select; use free_text only when multiple options doesn't make sense.",
      enum: ["free_text", "single_select", "multi_select"],
      type: "string",
    });
    expect(JSON.stringify(AskQuestionParametersSchema)).not.toMatch(
      /anyOf|oneOf|const/u
    );
  });

  it("keeps the public schema strict", () => {
    const host = createExtensionHost(askQuestion);
    const definition = host
      .getRegisteredTools()
      .get("ask_question")?.definition;
    expect(definition).toBeDefined();
    expect(AskQuestionParametersSchema).toHaveProperty(
      "additionalProperties",
      false
    );
    expect(questionSchema).toHaveProperty("additionalProperties", false);
  });

  it.each([
    {
      header: "Plan",
      question: "Which plan do you want?",
      type: "single_select",
    },
    {
      header: "Notes",
      options: [{ label: "Unexpected" }],
      question: "Anything else?",
      type: "free_text",
    },
  ])("rejects options that do not match the question type", (question) => {
    expect(() =>
      parseQuestionsFromParameters({ questions: [question] })
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
      labels: ["Alpha", " alpha "],
      message: "Duplicate option label: alpha",
    },
    {
      labels: ["Alpha", "   "],
      message: "Option labels must not be blank",
    },
    {
      labels: ["Alpha", " Other "],
      message:
        "Do not include an 'Other' option; the UI provides it automatically",
    },
  ])("rejects ambiguous labels: $labels", ({ labels, message }) => {
    expect(() =>
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            options: labels.map((label) => ({ label })),
            question: "Choose one",
            type: "single_select",
          },
        ],
      })
    ).toThrow(message);
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

  it("trims labels and reserves only the exact Other label", () => {
    expect(
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            options: [
              {
                details: "Best default for most teams.",
                label: " Fast (Suggested) ",
              },
              { label: "Other?" },
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
            details: undefined,
            kind: "option",
            label: "Other?",
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

describe("ask-question execution", () => {
  it("rejects custom UI outside TUI mode", async () => {
    await expect(
      executeTool(singleQuestionParams, { mode: "rpc" })
    ).rejects.toThrow("ask_question requires interactive UI");
  });

  it("returns cancellation details and aborts the run when the user cancels", async () => {
    const { result, abortCalls } = await executeTool(singleQuestionParams, {
      customKeys: [KEY_ESCAPE],
    });

    const details = expectCancelledResult(result);
    expect(details.abortedRun).toBeTruthy();
    expect(details.reason).toBe("user_cancelled");
    expect(result.content[0]?.text).toContain("cancelled");
    expect(result).toMatchObject({ terminate: true });
    expect(abortCalls).toBe(1);
  });

  it("returns external abort details when the run is aborted while open", async () => {
    const controller = new AbortController();
    const driver = createCustomUiDriver({
      onComponent: () => controller.abort(),
    });

    const { result, abortCalls } = await executeTool(singleQuestionParams, {
      custom: driver.custom,
      signal: controller.signal,
    });

    const details = expectCancelledResult(result);
    expect(details.reason).toBe("external_aborted");
    expect(result.content[0]?.text).toContain("aborted");
    expect(result).toMatchObject({ terminate: true });
    expect(abortCalls).toBe(1);
  });

  it("returns structured answers on success", async () => {
    const { blockedEvents, result } = await executeTool(singleQuestionParams, {
      customKeys: [KEY_ENTER, KEY_TAB, KEY_ENTER],
    });

    expect(blockedEvents).toStrictEqual([
      { active: true, label: "Waiting for answers" },
      { active: false },
    ]);

    const details = expectSuccessResult(result);
    expect(details.answers).toStrictEqual([
      {
        answer: {
          label: "Yes",
        },
        type: "single_select",
      },
    ]);
    expect(result.content[0]?.text).toContain("[Plan]");
    expect(result.content[0]?.text).toContain("Yes");
  });
});
