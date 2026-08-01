import { describe, expect, it } from "vitest";

import { createKeybindings } from "../../tests/harness/tui.js";
import {
  KEY_ENTER,
  KEY_SPACE,
  KEY_TAB,
  VIM_STYLE_KEYBINDINGS,
  executeTool,
  expectCancelledResult,
  expectSuccessResult,
  renderFlowWithKeys,
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

describe("ask-question TUI flow", () => {
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

  it("keeps single-select Other incomplete until it has text", async () => {
    const rendered = await renderFlowWithKeys(
      singleQuestionParams,
      ["j", "j", "y", "x", KEY_TAB, "y"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(rendered).toContain("• Plan: incomplete");
    expect(rendered).toContain("Incomplete: Plan");
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

  it("keeps multi-select Other incomplete until it has text", async () => {
    const rendered = await renderFlowWithKeys(
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
      ["j", "j", KEY_SPACE, "x", KEY_TAB, "y"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(rendered).toContain("• Features: incomplete");
    expect(rendered).toContain("Incomplete: Features");
  });

  it("renders inline details for the highlighted option", async () => {
    const params = {
      questions: [
        {
          header: "Plan",
          options: [
            {
              details: "Best default for most teams.",
              label: "Fast (Suggested)",
            },
            { label: "Safe" },
          ],
          question: "Which plan do you want?",
          type: "single_select" as const,
        },
      ],
    };

    const renderedWithDetails = await renderFlowWithKeys(params, []);
    const renderedWithoutDetails = await renderFlowWithKeys(
      params,
      ["j"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(renderedWithDetails).toContain("Details");
    expect(renderedWithDetails).toContain("Best default for most teams.");
    expect(renderedWithoutDetails).not.toContain(
      "Best default for most teams."
    );
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

  it("renders remapped keybinding labels instead of the defaults", async () => {
    const rendered = await renderFlowWithKeys(
      singleQuestionParams,
      [],
      VIM_STYLE_KEYBINDINGS
    );

    expect({
      hasArrows: rendered.includes("↑/↓"),
      hasCancel: rendered.includes("• x "),
      hasConfirm: rendered.includes(" y "),
      hasEnter: rendered.includes("Enter"),
      hasEsc: rendered.includes("Esc"),
      hasNav: rendered.includes("k/j"),
    }).toStrictEqual({
      hasArrows: false,
      hasCancel: true,
      hasConfirm: true,
      hasEnter: false,
      hasEsc: false,
      hasNav: true,
    });
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

  it("keeps the local note shortcut working", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeys: [
        KEY_ENTER,
        "n",
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

  it("accepts Kitty CSI-u printable shortcuts", async () => {
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

    expect(expectSuccessResult(result).answers[0]).toMatchObject({
      answer: { label: "Yes", note: "Needs approval" },
    });
  });
});
