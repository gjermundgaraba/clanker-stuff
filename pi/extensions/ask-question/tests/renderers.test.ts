import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { renderedRows, toolRenderContext } from "../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { questionRenderers } from "../renderers.js";
import { buildCancelledToolResult, buildSuccessToolResult } from "../tool.js";
import type { Question } from "../questions.js";

beforeAll(() => initTheme("dark"));
const theme = createIdentityTheme();
const question: Question = {
  header: "Scope",
  question: "Which targets?",
  multiSelect: true,
  options: [{ kind: "option", label: "Both", details: "Includes frontend and backend" }],
  placeholder: "Add a constraint",
};
const args = { questions: [question] };
const output = (text: string, details?: unknown) => ({
  content: [{ type: "text" as const, text }],
  details,
});

describe("question transcript rendering", () => {
  it("includes options and supporting detail in the bounded preview", () => {
    const render = questionRenderers("ask_question").renderCall;
    const collapsed = renderedRows(render(args, theme, toolRenderContext())).join("\n");
    expect(collapsed).toContain("ask_question\nScope · Which targets?\nChoose one or more\n- Both");
    expect(collapsed).toContain("Includes frontend and backend");
    expect(collapsed).toContain("1 more lines");
    expect(collapsed).toContain("to expand");
    const expanded = renderedRows(render(args, theme, toolRenderContext({ expanded: true }))).join(
      "\n",
    );
    expect(expanded).toContain(
      "Choose one or more\n- Both\nIncludes frontend and backend\nAdd a constraint",
    );
  });
  it("shows short options without requiring expansion when everything fits", () => {
    const data = {
      questions: [
        { header: "Proceed", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
      ],
    };
    const render = questionRenderers("ask_question").renderCall;
    for (const expanded of [false, true]) {
      expect(renderedRows(render(data, theme, toolRenderContext({ expanded }))).join("\n")).toBe(
        "ask_question\nProceed · Continue?\n- Yes\n- No",
      );
    }
  });
  it("renders asynchronous question titles and string options", () => {
    const data = {
      questions: [{ title: "Proceed?", options: ["Yes", "No"] }, { title: "Any constraints?" }],
    };
    const text = renderedRows(
      questionRenderers("request_user_input_async").renderCall(
        data,
        theme,
        toolRenderContext({ expanded: true }),
      ),
    ).join("\n");
    expect(text).toBe(
      "request_user_input_async\nQ1 · Proceed?\n- Yes\n- No\nQ2 · Any constraints?",
    );
  });
  it("renders messages literally rather than interpreting Markdown", () => {
    expect(
      renderedRows(
        questionRenderers("send_message_to_user_async").renderCall(
          { message: "- removed\n+ added\n**literal**" },
          theme,
          toolRenderContext(),
        ),
      ).join("\n"),
    ).toBe("send_message_to_user_async\n- removed\n+ added\n**literal**");
  });
  it("renders complete recorded answers and notes without mutating the result", () => {
    const data = buildSuccessToolResult([question], {
      cancelled: false,
      answers: [[{ label: "Both", note: "Keep **literal** text" }]],
    });
    const original = structuredClone(data);
    for (const expanded of [false, true]) {
      const text = renderedRows(
        questionRenderers("ask_question").renderResult(
          data,
          { expanded, isPartial: false },
          theme,
          toolRenderContext({ args, expanded }),
        ),
      ).join("\n");
      expect(text).toContain("✓ Answers received\nScope");
      expect(text).toContain("- Both\nNote: Keep **literal** text");
      expect(text.includes("Which targets?")).toBe(expanded);
    }
    expect(data).toEqual(original);
  });
  it("uses recorded answer details even when model-facing summary text was truncated", () => {
    const note = "note ".repeat(15000) + "END";
    const data = buildSuccessToolResult([question], {
      cancelled: false,
      answers: [[{ label: "Both", note }]],
    });
    expect(data.content[0].text).not.toContain("END");
    const render = questionRenderers("ask_question").renderResult;
    const collapsed = renderedRows(
      render(data, { expanded: false, isPartial: false }, theme, toolRenderContext({ args })),
    ).join("\n");
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("END");
    const expanded = renderedRows(
      render(
        data,
        { expanded: true, isPartial: false },
        theme,
        toolRenderContext({ args, expanded: true }),
      ),
    ).join("\n");
    expect(expanded).toContain("END");
  });
  it("reports the recorded cancellation reason and run abort", () => {
    for (const reason of ["user_cancelled", "external_aborted"] as const) {
      const data = buildCancelledToolResult(reason);
      const text = renderedRows(
        questionRenderers("ask_question").renderResult(
          data,
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext(),
        ),
      ).join("\n");
      expect(text).toBe(
        reason === "user_cancelled" ? "Cancelled by user · run aborted" : "Cancelled: run aborted",
      );
    }
  });
  it("reports asynchronous acceptance without inventing later answer or dismissal state", () => {
    for (const name of ["request_user_input_async", "send_message_to_user_async"] as const) {
      const data = output('{"accepted":true}', { accepted: true });
      const render = questionRenderers(name).renderResult;
      const component = render(
        data,
        { expanded: false, isPartial: false },
        theme,
        toolRenderContext(),
      );
      const expected =
        name === "request_user_input_async" ? "✓ Question queued" : "✓ Message submitted";
      expect(renderedRows(component).join("\n")).toBe(expected);
      component.invalidate();
      expect(renderedRows(component).join("\n")).toBe(expected);
      expect(
        renderedRows(
          render(
            output('{"accepted":false}', { accepted: false }),
            { expanded: false, isPartial: false },
            theme,
            toolRenderContext(),
          ),
        ).join("\n"),
      ).toBe('{"accepted":false}');
    }
  });
  it("never labels a partial or errored result as successful", () => {
    for (const isPartial of [false, true]) {
      const data = output("Not completed", { accepted: true });
      const text = renderedRows(
        questionRenderers("request_user_input_async").renderResult(
          data,
          { expanded: false, isPartial },
          theme,
          toolRenderContext({ isError: !isPartial }),
        ),
      ).join("\n");
      expect(text).toBe("Not completed");
    }
  });
  it("tolerates incomplete arguments and malformed history without inventing answers", () => {
    const render = questionRenderers("ask_question");
    for (const data of [null, {}, { questions: [null, { options: [null] }] }]) {
      expect(() =>
        renderedRows(
          render.renderCall(data, theme, toolRenderContext({ isPartial: true, expanded: true })),
        ),
      ).not.toThrow();
    }
    for (const answers of [null, [], [[]], [null], [[{ label: 123 }]]]) {
      const text = renderedRows(
        render.renderResult(
          output("Historical result", { cancelled: false, answers }),
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext(),
        ),
      ).join("\n");
      expect(text).toBe("Historical result");
    }
  });
  it("bounds previews and sanitizes arguments, selections, and notes", () => {
    const hostile = "\x1b[2J\u061c\u200e\u200f\u202e\u2066";
    const render = questionRenderers("ask_question");
    const components = [
      render.renderCall(
        { questions: [{ header: hostile, question: "中文".repeat(500) + hostile }] },
        theme,
        toolRenderContext(),
      ),
      render.renderResult(
        output("", {
          cancelled: false,
          answers: [[{ label: "中文".repeat(500) + hostile, note: hostile }]],
        }),
        { expanded: false, isPartial: false },
        theme,
        toolRenderContext(),
      ),
    ];
    for (const component of components)
      for (const width of [1, 2, 20, 80]) {
        const rows = component.render(width);
        expect(rows.length).toBeLessThanOrEqual(6);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        for (const control of ["\u061c", "\u200e", "\u200f", "\u202e", "\u2066", "\x1b[2J"])
          expect(rows.join("\n")).not.toContain(control);
      }
  });
  it("recreates themed content after invalidation", () => {
    const changing = createIdentityTheme();
    let color = "\x1b[31m";
    changing.fg = (_name, value) => color + value + "\x1b[0m";
    const component = questionRenderers("ask_question").renderCall(
      args,
      changing,
      toolRenderContext(),
    );
    expect(component.render(80).join("\n")).toContain("\x1b[31m");
    color = "\x1b[32m";
    component.invalidate();
    expect(component.render(80).join("\n")).toContain("\x1b[32m");
    expect(component.render(80).join("\n")).not.toContain("\x1b[31m");
  });
});
