import { describe, expect, it } from "vitest";

import {
  KEY_SPACE,
  KEY_TAB,
  VIM_STYLE_KEYBINDINGS,
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

describe("ask-question dialog rendering", () => {
  it("shows an incomplete single-select Other answer", async () => {
    const rendered = await renderFlowWithKeys(
      singleQuestionParams,
      ["j", "j", "y", "x", KEY_TAB, "y"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(rendered).toContain("• Plan: incomplete");
    expect(rendered).toContain("Incomplete: Plan");
  });

  it("shows an incomplete multi-select Other answer", async () => {
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

  it("shows details only for the highlighted option", async () => {
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
});
