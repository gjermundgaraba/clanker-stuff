import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKeybindings } from "../../../../tests/harness/tui.js";
import { MAX_ANSWER_BYTES, MAX_ANSWER_LINES, boundAnswerText } from "../../dialog/controller.js";
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
    },
  ],
};

const mixedQuestionParams = {
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
};

describe("ask-question dialog controller", () => {
  it("bounds answers by UTF-8 bytes and lines", () => {
    const bytes = boundAnswerText("🦄".repeat(MAX_ANSWER_BYTES));
    const lines = boundAnswerText(
      Array.from({ length: MAX_ANSWER_LINES + 5 }, () => "x").join("\n"),
    );

    expect(Buffer.byteLength(bytes)).toBe(MAX_ANSWER_BYTES);
    expect(lines.split("\n")).toHaveLength(MAX_ANSWER_LINES);
  });

  it("keeps the editor caret stable while bounding the saved answer", async () => {
    const setText = vi.spyOn(Editor.prototype, "setText");
    const { result } = await executeTool(
      {
        questions: [
          {
            header: "Notes",
            options: [{ label: "Something specific" }],
            question: "Anything else to add?",
          },
        ],
      },
      {
        customKeybindings: VIM_STYLE_KEYBINDINGS,
        customKeys: [
          "j",
          "y",
          "a".repeat(MAX_ANSWER_BYTES),
          "\u0002",
          "b",
          KEY_ENTER,
          KEY_TAB,
          "y",
        ],
      },
    );

    const details = expectSuccessResult(result);
    expect(setText).toHaveBeenCalledOnce();
    expect(details.answers[0]).toStrictEqual([
      {
        label: "Other",
        note: `${"a".repeat(MAX_ANSWER_BYTES - 1)}b`,
      },
    ]);
  });

  it("supports single-select and multi-select questions in one flow", async () => {
    const { result } = await executeTool(mixedQuestionParams, {
      customKeys: [KEY_ENTER, KEY_TAB, KEY_SPACE, KEY_ENTER, KEY_ENTER],
    });

    const details = expectSuccessResult(result);
    expect(details.answers).toStrictEqual([[{ label: "Alpha" }], [{ label: "Feature A" }]]);
  });

  it("supports the implicit Other field for single-select questions", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: ["j", "j", "y", ...Array.from("Enterprise self-hosted"), KEY_ENTER, KEY_TAB, "y"],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toStrictEqual([
      {
        label: "Other",
        note: "Enterprise self-hosted",
      },
    ]);
  });

  it("supports the implicit Other field alongside multi-select choices", async () => {
    const { result } = await executeTool(
      {
        questions: [
          {
            header: "Features",
            multiSelect: true,
            options: [{ label: "Feature A" }, { label: "Feature B" }],
            question: "Which features do you need?",
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
          ...Array.from("Custom integration"),
          KEY_ENTER,
          KEY_TAB,
          "y",
        ],
      },
    );

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toStrictEqual([
      { label: "Feature A" },
      { label: "Other", note: "Custom integration" },
    ]);
  });

  it("uses injected keybindings for confirm and vertical navigation", async () => {
    const { result } = await executeTool(singleQuestionParams, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: ["j", "k", "j", "y", KEY_TAB, "y"],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toStrictEqual([{ label: "No" }]);
  });

  it("clears row-specific hints after moving the cursor", async () => {
    const params = {
      questions: [
        {
          header: "Features",
          multiSelect: true,
          options: [{ label: "Feature A" }, { label: "Feature B" }],
          question: "Which features do you need?",
        },
      ],
    };

    const withHint = await renderFlowWithKeys(params, ["y"], VIM_STYLE_KEYBINDINGS);
    const afterMove = await renderFlowWithKeys(params, ["y", "j"], VIM_STYLE_KEYBINDINGS);

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
        ...Array.from("Needs approval"),
        KEY_ENTER,
        KEY_TAB,
        KEY_ENTER,
      ],
    });

    const details = expectSuccessResult(result);
    expect(details.answers[0]).toStrictEqual([
      {
        label: "Yes",
        note: "Needs approval",
      },
    ]);
  });
});
