import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  createIdentityTheme,
  createKeybindings,
} from "../../../../tests/harness/tui.js";
import { createHelpText } from "../../dialog/input.js";
import { renderPrompt } from "../../dialog/render.js";
import { createQuestionSessions } from "../../questions.js";
import type { Question } from "../../questions.js";
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

  it("renders remapped help and the active edit target", async () => {
    const initial = await renderFlowWithKeys(
      singleQuestionParams,
      [],
      VIM_STYLE_KEYBINDINGS
    );
    const editing = await renderFlowWithKeys(
      singleQuestionParams,
      ["y", "n"],
      createKeybindings({
        "tui.input.submit": ["s"],
        "tui.select.cancel": ["x"],
        "tui.select.confirm": ["y"],
        "tui.select.down": ["j"],
        "tui.select.up": ["k"],
      })
    );

    expect(initial).toContain("k/j move");
    expect(initial).toContain("x cancel questionnaire");
    expect(editing).toContain("Editing note for: Yes");
    expect(editing).toContain("s save • x discard");
  });

  it("describes Space as a toggle for multi-select Other", async () => {
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
      ["j", "j"],
      VIM_STYLE_KEYBINDINGS
    );

    expect(rendered).toContain("Space toggle • y edit Other");
  });

  it("preserves styling across multiline details", () => {
    const dim = "\u001B[2m";
    const reset = "\u001B[0m";
    const identityTheme = createIdentityTheme();
    const theme = {
      ...identityTheme,
      fg: (color: string, text: string) =>
        color === "muted" ? `${dim}${text}${reset}` : text,
    } as Theme;
    const question: Question = {
      header: "Plan",
      options: [
        {
          details: "First line\nSecond line",
          kind: "option",
          label: "Fast",
        },
        { kind: "other", label: "Other" },
      ],
      question: "Which plan do you want?",
      type: "single_select",
    };

    const rendered = renderPrompt(
      {
        currentTab: 0,
        editMode: { kind: "none" },
        helpText: createHelpText(createKeybindings()),
        hint: "",
        sessions: createQuestionSessions([question]),
        theme,
      },
      80
    );

    expect(rendered.find((line) => line.includes("First line"))).toContain(dim);
    expect(rendered.find((line) => line.includes("Second line"))).toContain(
      dim
    );
  });

  it("wraps tabs so the active Submit tab remains visible", () => {
    const questions: Question[] = ["One", "Two", "Three", "Four", "Five"].map(
      (header) => ({
        header,
        options: [
          { kind: "option", label: "Yes" },
          { kind: "other", label: "Other" },
        ],
        question: `${header}?`,
        type: "single_select",
      })
    );
    const sessions = createQuestionSessions(questions);
    const rendered = renderPrompt(
      {
        currentTab: sessions.length,
        editMode: { kind: "none" },
        helpText: createHelpText(createKeybindings()),
        hint: "",
        sessions,
        theme: createIdentityTheme(),
      },
      24
    );

    expect(rendered.slice(1, rendered.indexOf("")).join(" ")).toContain(
      "Submit"
    );
  });

  it("bounds lines when a prefix is wider than the viewport", () => {
    const question: Question = {
      header: "Notes",
      question: "Anything else?",
      type: "free_text",
    };
    const sessions = createQuestionSessions([question]);
    const [session] = sessions;
    if (!session) {
      throw new Error("expected question session");
    }
    session.state.freeText = "answer";

    const rendered = renderPrompt(
      {
        currentTab: 0,
        editMode: { kind: "none" },
        helpText: createHelpText(createKeybindings()),
        hint: "",
        sessions,
        theme: createIdentityTheme(),
      },
      8
    );

    expect(rendered.every((line) => visibleWidth(line) <= 8)).toBeTruthy();
    expect(rendered.join("\n")).toContain("answer");
  });
});
