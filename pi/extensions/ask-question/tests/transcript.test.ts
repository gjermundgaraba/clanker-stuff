import { describe, expect, it, vi } from "vite-plus/test";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { createInteraction, transition } from "../interaction.js";
import { answerMessage, answerResult, isDelivered } from "../delivery.js";
import { createAnswerMarkdownTransformer, renderCall, renderResult } from "../transcript.js";
const request = {
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
const context = {
  args: request,
  toolCallId: "test",
  invalidate: () => {},
  lastComponent: undefined,
  state: {},
  cwd: "/tmp",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
};
describe("compact questionnaire transcript", () => {
  it("projects only exact known user answers, preserving notes, revisions and canonical delivery", () => {
    let item = createInteraction("q_display", request, "call", "async");
    item = transition(item, item.version, { type: "select", question: "q", option: "a" });
    item = transition(item, item.version, {
      type: "note",
      question: "q",
      option: "a",
      text: "Option note",
    });
    item = transition(item, item.version, { type: "submit" });
    item = transition(item, item.version, {
      type: "reopen",
      base: 1,
      initiated_by: "user",
      mode: "async",
    });
    item = transition(item, item.version, {
      type: "custom",
      question: "q",
      text: "A written alternative\n```\n# literal text\n```",
    });
    item = transition(item, item.version, {
      type: "note",
      question: "q",
      text: "Written-answer note",
    });
    item = transition(item, item.version, { type: "note", text: "x".repeat(900) + "END_NOTE" });
    item = transition(item, item.version, { type: "submit" });
    const read = vi.fn(() => [item]);
    const transform = createAnswerMarkdownTransformer(read);
    const ctx = { messageType: "user" as const, isStreaming: false, availableWidth: 80 };
    const submission = item.submissions[1];
    const wire = answerMessage(item, submission);
    const before = JSON.stringify(item);
    const projected = transform(wire, ctx);
    expect(projected).not.toContain('"type":"questionnaire_answer"');
    expect(projected).not.toContain(item.id);
    expect(projected).not.toContain("Option note"); // Deselected option notes stay private.
    expect(transform(answerMessage(item, item.submissions[0]), ctx)).toContain("Option note");
    initTheme("dark");
    const render = (markdown: string) =>
      new Markdown(markdown, 0, 0, getMarkdownTheme()).render(80).join("\n");
    const rendered = render(projected);
    expect(rendered).toContain("supersedes revision 1");
    expect(rendered).toContain("Written-answer note");
    expect(rendered).toContain("END_NOTE");
    expect(rendered).toContain("Changed: Q, Questionnaire note");
    // User text stays literal: fences, headings and hard breaks render as text lines.
    expect(rendered).toContain("# literal text");
    expect(rendered).toContain("```");
    expect(rendered).not.toMatch(/\\[#`-]/);
    expect(rendered.indexOf("A written alternative")).toBeLessThan(
      rendered.indexOf("# literal text"),
    );
    expect(rendered.split("\n").some((line) => line.trimEnd().endsWith("\\"))).toBe(false);
    expect(JSON.stringify(item)).toBe(before);
    expect(answerMessage(item, submission)).toBe(wire);
    expect(
      isDelivered(item, submission, [
        {
          type: "message",
          id: "message",
          parentId: null,
          timestamp: submission.timestamp,
          message: { role: "user", content: wire, timestamp: 0 },
        },
      ]),
    ).toBe(true);
    for (const untouched of [
      wire + "\nUnrelated queued text",
      "Quoted answer:\n" + wire,
      wire.replace("END_NOTE", "EDITED_NOTE"),
      wire.replace("q_display", "q_unknown"),
    ])
      expect(transform(untouched, ctx)).toBe(untouched);
    expect(createAnswerMarkdownTransformer(() => [])(wire, ctx)).toBe(wire);
    read.mockClear();
    expect(transform(wire, { ...ctx, messageType: "assistant" })).toBe(wire);
    expect(transform(wire, { ...ctx, messageType: "assistant-thinking" })).toBe(wire);
    expect(transform("Ordinary user prose", ctx)).toBe("Ordinary user prose");
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps collapsed calls concise and exposes the complete authored request when expanded", () => {
    const collapsed = renderCall(request, theme, context, "async").render(100).join("\n");
    expect(collapsed).toContain("async · 1 question");
    expect(collapsed).not.toContain("Complete preview contents");
    expect(
      renderCall(request, theme, { ...context, expanded: true }, "async")
        .render(100)
        .join("\n"),
    ).toContain("Complete preview contents");
    expect(
      renderResult(
        { content: [{ type: "text", text: '{"accepted":true}' }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        context,
      )
        .render(100)
        .join("\n"),
    ).toContain("Pending · not answered yet");
    for (const [status, label] of [
      ["cancelled", "Cancelled by the user"],
      ["delivery_paused", "draft kept"],
    ])
      expect(
        renderResult(
          {
            content: [{ type: "text", text: JSON.stringify({ interaction_id: "q_x", status }) }],
            details: {},
          },
          { expanded: false, isPartial: false },
          theme,
          context,
        )
          .render(100)
          .join("\n"),
      ).toContain(label);
    expect(
      renderCall(
        { revise: { interaction_id: "q_known", base_revision: 1, reason: "Why" } },
        theme,
        context,
        "blocking",
        (id) => (id === "q_known" ? "Known title" : undefined),
      )
        .render(100)
        .join("\n"),
    ).toContain("Known title · blocking · revision request");
  });
  it("renders a short answer summary without truncating the submitted notes", () => {
    let item = createInteraction("q_test", request, "call", "blocking");
    item = transition(item, item.version, { type: "select", question: "q", option: "a" });
    item = transition(item, item.version, { type: "note", text: "x".repeat(900) + "END_NOTE" });
    item = transition(item, item.version, { type: "submit" });
    const result = answerResult(item, item.submissions[0]);
    const before = JSON.stringify(result);
    const collapsed = renderResult(result, { expanded: false, isPartial: false }, theme, context)
      .render(100)
      .join("\n");
    expect(collapsed).toContain("Answered · revision 1");
    expect(collapsed).toContain("Q");
    expect(collapsed).toContain("✓ A");
    expect(collapsed).not.toContain("q_test");
    expect(collapsed).not.toContain("END_NOTE");
    expect(
      renderResult(result, { expanded: true, isPartial: false }, theme, context)
        .render(100)
        .join("\n"),
    ).toContain("END_NOTE");
    expect(JSON.stringify(result)).toBe(before);
  });
  it("bounds visual rows, strips hostile controls, and refreshes themes", () => {
    initTheme("dark");
    const hostile = "\x1b[2J\u061c\u200e\u200f\u202e\u2066";
    const changing = createIdentityTheme();
    let color = "\x1b[31m";
    changing.fg = (_name, value) => color + value + "\x1b[0m";
    const component = renderCall(
      { ...request, title: "中文".repeat(100) + hostile },
      changing,
      context,
      "async",
    );
    const result = renderResult(
      { content: [{ type: "text", text: "中文".repeat(100) + hostile }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    for (const view of [component, result])
      for (const width of [1, 2, 20, 80]) {
        const rows = view.render(width);
        expect(rows.length).toBeLessThanOrEqual(6);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        for (const control of ["\x1b[2J", "\u061c", "\u200e", "\u200f", "\u202e", "\u2066"])
          expect(rows.join("\n")).not.toContain(control);
      }
    expect(component.render(80).join("\n")).toContain("\x1b[31m");
    color = "\x1b[32m";
    component.invalidate();
    expect(component.render(80).join("\n")).toContain("\x1b[32m");
    expect(component.render(80).join("\n")).not.toContain("\x1b[31m");
  });
  it("does not interpret partial or failed acceptance as pending success", () => {
    for (const isPartial of [false, true]) {
      const text = renderResult(
        { content: [{ type: "text", text: '{"accepted":true}' }], details: {} },
        { expanded: false, isPartial },
        theme,
        { ...context, isError: !isPartial },
      )
        .render(80)
        .join("\n");
      expect(text).not.toContain("Pending");
      expect(text).toContain('{"accepted":true}');
    }
  });
});
