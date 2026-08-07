import { describe, expect, it } from "vitest";

import { createKeybindings } from "../../../../tests/harness/tui.js";
import {
  KEY_ENTER,
  KEY_SPACE,
  KEY_TAB,
  VIM_STYLE_KEYBINDINGS,
  executeTool,
  expectCancelledResult,
  expectSuccessResult,
  renderFlowWithKeys,
} from "../helpers.js";

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

const allQuestionTypesParams = {
  questions: [
    {
      header: "Plan",
      options: [{ label: "Alpha" }, { label: "Beta" }],
      question: "Which plan do you want?",
      type: "single_select" as const,
    },
    {
      header: "Features",
      options: [{ label: "Feature A" }, { label: "Feature B" }],
      question: "Which features do you need?",
      type: "multi_select" as const,
    },
    {
      header: "Notes",
      question: "Anything else to add?",
      type: "free_text" as const,
    },
  ],
};

describe("ask-question dialog controller", () => {
  it("supports all question types in one flow", async () => {
    const { result } = await executeTool(allQuestionTypesParams, {
      customKeys: [
        KEY_ENTER,
        KEY_TAB,
        KEY_SPACE,
        KEY_ENTER,
        KEY_ENTER,
        ..."Need examples and docs",
        KEY_ENTER,
        KEY_TAB,
        KEY_ENTER,
      ],
    });

    const details = expectSuccessResult(result);
    expect(details.answers).toHaveLength(3);
    expect(details.answers[0]).toMatchObject({
      answer: {
        label: "Alpha",
      },
      type: "single_select",
    });
    expect(details.answers[1]).toMatchObject({
      answer: [{ label: "Feature A" }],
      type: "multi_select",
    });
    expect(details.answers[2]).toMatchObject({
      answer: {
        text: "Need examples and docs",
      },
      type: "free_text",
    });
  });

  it("supports the implicit Other field for single-select questions", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: [
        "j",
        "j",
        "y",
        ..."Enterprise self-hosted",
        KEY_ENTER,
        KEY_TAB,
        "y",
      ],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toMatchObject({
      answer: {
        label: "Other",
        note: "Enterprise self-hosted",
      },
      type: "single_select",
    });
  });

  it("supports the implicit Other field alongside multi-select choices", async () => {
    const { result } = await executeTool(
      {
        questions: [
          {
            header: "Features",
            options: [{ label: "Feature A" }, { label: "Feature B" }],
            question: "Which features do you need?",
            type: "multi_select" as const,
          },
        ],
      },
      {
        customKeybindings: VIM_STYLE_KEYBINDINGS,
        customKeys: [
          KEY_SPACE,
          "j",
          "j",
          "y",
          ..."Custom integration",
          KEY_ENTER,
          KEY_TAB,
          "y",
        ],
      }
    );

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toMatchObject({
      answer: [
        { label: "Feature A" },
        { label: "Other", note: "Custom integration" },
      ],
      type: "multi_select",
    });
  });

  it("uses injected keybindings for confirm and vertical navigation", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: ["j", "k", "j", "y", KEY_TAB, "y"],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toMatchObject({
      answer: {
        label: "No",
      },
      type: "single_select",
    });
  });

  it("clears row-specific hints after moving the cursor", async () => {
    const params = {
      questions: [
        {
          header: "Features",
          options: [{ label: "Feature A" }, { label: "Feature B" }],
          question: "Which features do you need?",
          type: "multi_select" as const,
        },
      ],
    };

    const withHint = await renderFlowWithKeys(
      params,
      ["y"],
      VIM_STYLE_KEYBINDINGS
    );
    const afterMove = await renderFlowWithKeys(
      params,
      ["y", "j"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(withHint).toContain("This question is incomplete");
    expect(afterMove).not.toContain("This question is incomplete");
  });

  it("uses the injected cancel keybinding", async () => {
    const { result, abortCalls } = await executeTool(singleQuestionParams, {
      customKeybindings: createKeybindings({
        "tui.select.cancel": ["x"],
        "tui.select.confirm": ["y"],
      }),
      customKeys: ["x"],
    });

    const details = expectCancelledResult(result);
    expect(details.reason).toBe("user_cancelled");
    expect(abortCalls).toBe(1);
  });

  it("routes Kitty CSI-u note shortcuts through the controller", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeys: [
        KEY_ENTER,
        "\u001B[110u",
        ..."Needs approval",
        KEY_ENTER,
        KEY_TAB,
        KEY_ENTER,
      ],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toMatchObject({
      answer: {
        label: "Yes",
        note: "Needs approval",
      },
      type: "single_select",
    });
  });
});
