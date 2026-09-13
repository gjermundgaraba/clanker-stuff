import type { Question } from "../../questions.js";
import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKeybindings } from "../../../../tests/harness/tui.js";
import { MAX_ANSWER_BYTES, MAX_ANSWER_LINES, boundAnswerText } from "../../dialog/controller.js";
import {
  KEY_ENTER,
  KEY_SPACE,
  KEY_TAB,
  VIM_STYLE_KEYBINDINGS,
  executePrompt,
  expectAnswers,
  renderFlowWithKeys,
} from "./helpers.js";

const singleQuestion: Question[] = [
  {
    header: "Plan",
    multiSelect: false,
    options: [
      { kind: "option", label: "Yes" },
      { kind: "option", label: "No" },
      { kind: "other", label: "Other" },
    ],
    question: "Which plan do you want?",
  },
];

const mixedQuestions: Question[] = [
  {
    header: "Plan",
    multiSelect: false,
    options: [
      { kind: "option", label: "Alpha" },
      { kind: "option", label: "Beta" },
      { kind: "other", label: "Other" },
    ],
    question: "Which plan do you want?",
  },
  {
    header: "Features",
    multiSelect: true,
    options: [
      { kind: "option", label: "Feature A" },
      { kind: "option", label: "Feature B" },
      { kind: "other", label: "Other" },
    ],
    question: "Which features do you need?",
  },
];

describe("question dialog controller", () => {
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
    const result = await executePrompt(
      [
        {
          header: "Notes",
          multiSelect: false,
          options: [
            { kind: "option", label: "Something specific" },
            { kind: "other", label: "Other" },
          ],
          question: "Anything else to add?",
        },
      ],
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

    const answers = expectAnswers(result);
    expect(setText).toHaveBeenCalledOnce();
    expect(answers[0]).toStrictEqual([
      {
        label: "Other",
        note: `${"a".repeat(MAX_ANSWER_BYTES - 1)}b`,
      },
    ]);
  });

  it("supports single-select and multi-select questions in one flow", async () => {
    const result = await executePrompt(mixedQuestions, {
      customKeys: [KEY_ENTER, KEY_TAB, KEY_SPACE, KEY_ENTER, KEY_ENTER],
    });

    const answers = expectAnswers(result);
    expect(answers).toStrictEqual([[{ label: "Alpha" }], [{ label: "Feature A" }]]);
  });

  it("supports the Other field for single-select questions", async () => {
    const result = await executePrompt(singleQuestion, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: ["j", "j", "y", ...Array.from("Enterprise self-hosted"), KEY_ENTER, KEY_TAB, "y"],
    });

    const answers = expectAnswers(result);
    expect(answers[0]).toStrictEqual([
      {
        label: "Other",
        note: "Enterprise self-hosted",
      },
    ]);
  });

  it("supports the Other field alongside multi-select choices", async () => {
    const result = await executePrompt(
      [
        {
          header: "Features",
          multiSelect: true,
          options: [
            { kind: "option", label: "Feature A" },
            { kind: "option", label: "Feature B" },
            { kind: "other", label: "Other" },
          ],
          question: "Which features do you need?",
        },
      ],
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

    const answers = expectAnswers(result);
    expect(answers[0]).toStrictEqual([
      { label: "Feature A" },
      { label: "Other", note: "Custom integration" },
    ]);
  });

  it("uses injected keybindings for confirm and vertical navigation", async () => {
    const result = await executePrompt(singleQuestion, {
      customKeybindings: VIM_STYLE_KEYBINDINGS,
      customKeys: ["j", "k", "j", "y", KEY_TAB, "y"],
    });

    const answers = expectAnswers(result);
    expect(answers[0]).toStrictEqual([{ label: "No" }]);
  });

  it("clears row-specific hints after moving the cursor", async () => {
    const params: Question[] = [
      {
        header: "Features",
        multiSelect: true,
        options: [
          { kind: "option", label: "Feature A" },
          { kind: "option", label: "Feature B" },
          { kind: "other", label: "Other" },
        ],
        question: "Which features do you need?",
      },
    ];

    const withHint = await renderFlowWithKeys(params, ["y"], VIM_STYLE_KEYBINDINGS);
    const afterMove = await renderFlowWithKeys(params, ["y", "j"], VIM_STYLE_KEYBINDINGS);

    expect(withHint).toContain("This question is incomplete");
    expect(afterMove).not.toContain("This question is incomplete");
  });

  it("uses the injected cancel keybinding", async () => {
    const result = await executePrompt(singleQuestion, {
      customKeybindings: createKeybindings({
        "tui.select.cancel": ["x"],
        "tui.select.confirm": ["y"],
      }),
      customKeys: ["x"],
    });

    expect(result).toEqual({ cancelled: true, reason: "user_cancelled" });
  });

  it("routes Kitty CSI-u note shortcuts through the controller", async () => {
    const result = await executePrompt(singleQuestion, {
      customKeys: [
        KEY_ENTER,
        "\u001B[110u",
        ...Array.from("Needs approval"),
        KEY_ENTER,
        KEY_TAB,
        KEY_ENTER,
      ],
    });

    const answers = expectAnswers(result);
    expect(answers[0]).toStrictEqual([
      {
        label: "Yes",
        note: "Needs approval",
      },
    ]);
  });
});
