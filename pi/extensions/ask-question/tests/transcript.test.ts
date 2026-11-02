import assert from "node:assert/strict";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { toolRenderContext } from "../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { MESSAGE_TYPE, outcome, toolResult } from "../delivery.js";
import type { Outcome } from "../delivery.js";
import {
  collectAnswers,
  createInteraction,
  transition,
} from "../interaction.js";
import {
  renderCall,
  renderOutcomeMessage,
  renderResult,
} from "../transcript.js";

const request = {
  wait: false,
  title: "Synthetic request",
  questions: [
    {
      id: "q",
      header: "Q",
      question: "Choose?",
      options: [{ id: "a", label: "A", preview: "Complete preview contents" }],
    },
  ],
};

const theme = createIdentityTheme();

const context = { ...toolRenderContext({ toolCallId: "test" }), args: request };

const answeredOutcome = (note = "Option note"): Outcome => {
  let item = createInteraction("q_display", request, "call");
  item = transition(item, { type: "select", question: "q", option: "a" });
  item = transition(item, {
    type: "note",
    question: "q",
    option: "a",
    text: note,
  });

  return outcome(item, "answered", collectAnswers(item));
};

const message = (details: unknown) => ({
  role: "custom" as const,
  customType: MESSAGE_TYPE,
  content: JSON.stringify(details),
  display: true,
  details,
  timestamp: 0,
});

const messageOptions = { ...toolRenderContext(), expanded: false };

const rows = (component: { render: (width: number) => string[] } | undefined) =>
  component
    ?.render(100)
    .map((row) => row.trimEnd())
    .join("\n");

describe("compact questionnaire transcript", () => {
  it("renders answers that arrived as messages from their own details", () => {
    initTheme("dark");
    const details = answeredOutcome("Line one\nLine two");

    const rendered = rows(
      renderOutcomeMessage(message(details), messageOptions, theme)
    );

    expect(rendered).toContain("Synthetic request · ✓ Answered");
    expect(rendered).toContain("1. Q");
    expect(rendered).toContain("✓ A");
    expect(rendered).toContain("     Note: Line one\n           Line two");
    expect(rendered).not.toContain("q_display");
    expect(rendered).not.toContain('"type"');

    const dismissed = { ...details, status: "dismissed" as const };
    delete dismissed.answers;
    expect(
      rows(renderOutcomeMessage(message(dismissed), messageOptions, theme))
    ).toBe(" Synthetic request · Dismissed · not answered");
    expect(
      renderOutcomeMessage(
        message({ status: "answered" }),
        messageOptions,
        theme
      )
    ).toBeUndefined();
  });

  it("keeps collapsed calls concise and exposes the complete authored request when expanded", () => {
    const collapsed = rows(renderCall(request, theme, context));

    expect(collapsed).toContain("Synthetic request · async · 1 question");
    expect(collapsed).not.toContain("Complete preview contents");
    expect(
      rows(renderCall({ ...request, wait: true }, theme, context))
    ).toContain("· waiting ·");
    expect(
      rows(renderCall(request, theme, { ...context, expanded: true }))
    ).toContain("Complete preview contents");

    const item = createInteraction("q_x", request, "call");

    for (const [status, label] of [
      ["pending", "Pending · not answered yet"],
      ["closed", "draft kept"],
      ["dismissed", "Dismissed · not answered"],
    ] as const) {
      expect(
        rows(
          renderResult(
            toolResult(outcome(item, status)),
            { expanded: false, isPartial: false },
            theme,
            context
          )
        )
      ).toContain(label);
    }
  });

  it("summarizes answered results and shows every note when expanded", () => {
    const result = toolResult(answeredOutcome(`${"x".repeat(900)}END_NOTE`));
    const before = JSON.stringify(result);

    const collapsed = rows(
      renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );

    expect(collapsed).toContain("✓ Answered");
    expect(collapsed).toContain("✓ A");
    expect(collapsed).not.toContain("q_display");
    expect(collapsed).not.toContain("END_NOTE");
    expect(
      rows(
        renderResult(result, { expanded: true, isPartial: false }, theme, {
          ...context,
          expanded: true,
        })
      )
    ).toContain("END_NOTE");
    expect(JSON.stringify(result)).toBe(before);
  });

  it("bounds visual rows, strips hostile controls, and refreshes themes", () => {
    initTheme("dark");
    const hostile = "\u001B[2J؜‎‏‮⁦";
    const changing = createIdentityTheme();
    let color = "\u001B[31m";
    changing.fg = (_name, value) => `${color + value}\u001B[0m`;

    const component = renderCall(
      { ...request, title: "中文".repeat(100) + hostile },
      changing,
      context
    );

    const details = answeredOutcome("中文".repeat(100) + hostile);

    const views = [
      component,
      renderResult(
        {
          content: [{ type: "text", text: "中文".repeat(100) + hostile }],
          details: {},
        },
        { expanded: false, isPartial: false },
        theme,
        context
      ),
      renderOutcomeMessage(
        message({ ...details, title: hostile }),
        messageOptions,
        theme
      ),
    ];

    for (const view of views) {
      assert.ok(view);

      for (const width of [1, 2, 20, 80]) {
        const lines = view.render(width);
        expect(lines.length).toBeLessThanOrEqual(13);
        expect(lines.every((row) => visibleWidth(row) <= width)).toBe(true);

        for (const control of ["\u001B[2J", "؜", "‎", "‏", "‮", "⁦"]) {
          expect(lines.join("\n")).not.toContain(control);
        }
      }
    }

    expect(rows(component)).toContain("\u001B[31m");
    color = "\u001B[32m";
    component.invalidate();
    expect(rows(component)).toContain("\u001B[32m");
    expect(rows(component)).not.toContain("\u001B[31m");
  });

  it("keeps partial, failed and unrecognized results as literal output", () => {
    const text = JSON.stringify({ status: "pending" });

    for (const [isPartial, isError, details] of [
      [false, false, undefined],
      [true, false, outcome(createInteraction("q_x", request, "c"), "pending")],
      [false, true, outcome(createInteraction("q_x", request, "c"), "pending")],
    ] as const) {
      const rendered = rows(
        renderResult(
          { content: [{ type: "text", text }], details },
          { expanded: false, isPartial },
          theme,
          { ...context, isError }
        )
      );

      expect(rendered).toContain(text);
      expect(rendered).not.toContain("Pending ·");
    }
  });
});
