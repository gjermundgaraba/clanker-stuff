import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import askQuestion from "../index.js";
import {
  AskQuestionParametersSchema,
  buildSuccessToolResult,
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
    },
  ],
};

const questionSchema = AskQuestionParametersSchema.properties.questions.items;

describe("ask-question contract", () => {
  it("emits a Google-safe schema with optional multiSelect boolean", () => {
    expect(questionSchema.properties.multiSelect).toMatchObject({
      description:
        "Allow choosing several options. Defaults to one choice per question.",
      type: "boolean",
    });
    expect(questionSchema.required).toContain("options");
    expect(questionSchema.required).not.toContain("multiSelect");
    expect(JSON.stringify(AskQuestionParametersSchema)).not.toMatch(
      /anyOf|oneOf|const/u
    );
  });

  it("keeps the public schema strict", async () => {
    const host = createExtensionHost(askQuestion);
    await host.ready;
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

  it("rejects questions without options", () => {
    expect(() =>
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Plan",
            question: "Which plan do you want?",
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
          },
        ],
      })
    ).toThrow(message);
  });

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
          },
        ],
      })
    ).toStrictEqual([
      {
        header: "Plan",
        multiSelect: false,
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
      },
    ]);
  });

  it("rejects blank display strings and strips terminal controls", () => {
    expect(() =>
      parseQuestionsFromParameters({
        questions: [
          {
            header: "\u001B]52;c;secret\u0007",
            options: [{ label: "Yes" }],
            question: "   ",
          },
        ],
      })
    ).toThrow("Question headers and prompts must not be blank");

    expect(
      parseQuestionsFromParameters({
        questions: [
          {
            header: "Pl\u001B]52;c;secret\u0007an",
            options: [{ label: "Yes" }],
            question: "Which\u009B plan?",
          },
        ],
      })
    ).toMatchObject([
      {
        header: "Pl]52;c;secretan",
        question: "Which plan?",
      },
    ]);

    const [sanitized] = parseQuestionsFromParameters({
      questions: [
        {
          header: "Pl\ran",
          multiSelect: true,
          options: [{ details: "Why\tthis", label: "Ye\ts" }],
          placeholder: "Pick\r\tone",
          question: "Line one\nLine\rtwo\t?",
        },
      ],
    });
    expect(sanitized).toMatchObject({
      header: "Plan",
      multiSelect: true,
      placeholder: "Pickone",
      question: "Line one\nLinetwo?",
    });
    expect(sanitized?.options[0]).toMatchObject({
      details: "Whythis",
      label: "Yes",
    });
  });

  it("builds summaries from aligned answers", () => {
    const questions = parseQuestionsFromParameters({
      questions: [
        {
          header: "Plan",
          options: [{ label: "Alpha" }, { label: "Beta" }],
          question: "Which plan do you want?",
        },
        {
          header: "Features",
          multiSelect: true,
          options: [{ label: "Feature A" }, { label: "Feature B" }],
          question: "Which features do you need?",
        },
      ],
    });

    expect(
      buildSummaryContent(questions, [
        [{ label: "Alpha" }],
        [{ label: "Feature A" }, { label: "Feature B", note: "Need examples" }],
      ])
    ).toBe(
      [
        "User answered:",
        "- [Plan] Which plan do you want? -> Alpha",
        "- [Features] Which features do you need? -> Feature A, Feature B",
        "  notes:",
        "  - Feature B: Need examples",
      ].join("\n")
    );
  });

  it("bounds final tool text to pi's output contract", () => {
    const question = parseQuestionsFromParameters({
      questions: [
        {
          header: "Notes",
          options: [{ label: "Something specific" }],
          question: "Anything else?",
        },
      ],
    });
    const result = buildSuccessToolResult(question, {
      answers: [
        [
          {
            label: "Other",
            note: "line\n".repeat(3000),
          },
        ],
      ],
      cancelled: false,
    });

    expect(
      Buffer.byteLength(result.content[0]?.text ?? "")
    ).toBeLessThanOrEqual(50_000);
    expect(result.content[0]?.text.split("\n").length).toBeLessThanOrEqual(
      2000
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
    expect(details.answers).toStrictEqual([[{ label: "Yes" }]]);
    expect(result.content[0]?.text).toContain("[Plan]");
    expect(result.content[0]?.text).toContain("Yes");
  });
});
