import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { createInteraction, transition } from "../interaction.js";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import {
  diffText,
  inboxLabel,
  optionDetailText,
  optionLines,
  progressLine,
  renderQuestionView,
  renderScrollablePage,
  reviewText,
} from "../tui/render.js";

const request = {
  title: "Release plan",
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where should the release run?",
      options: [
        { id: "local", label: "Local", description: "No hosting required" },
        { id: "cloud", label: "Cloud", description: "Accessible to the team" },
      ],
      recommendation: { option_ids: ["local"], reason: "Recommendation rationale" },
    },
    {
      id: "timing",
      header: "Timing",
      question: "When should it run?",
      options: [{ id: "now", label: "Now" }],
    },
  ] satisfies [import("../request.js").Question, import("../request.js").Question],
};

const fresh = () => createInteraction("q_private_identifier", request, "call", "async");

const theme = createIdentityTheme();

describe("questionnaire presentation", () => {
  it("lists compact options with focus, selection, note excerpts and detail markers", () => {
    initTheme("dark");
    const item = fresh();
    const q = request.questions[0];
    const a = item.draft?.answers.target;
    assert(a);
    a.selected = ["cloud"];
    a.notes.local = "Keep the local data\nSecond line";
    const result = optionLines(q, a, 0, 60, theme);
    const text = displayText(result.join("\n"));
    expect(text).toContain("> ( ) 1. Local\u00a0★");
    expect(text).toContain("  (•) 2. Cloud");
    expect(text).toContain("Note: Keep the local data …");
    expect(text).not.toContain("Second line");
    expect(text).not.toContain("No hosting required"); // Descriptions live in Details.
    expect(optionLines({ ...q, multi_select: true }, a, 1, 60, theme).join("\n")).toContain(
      "[x] 2. Cloud",
    );
    expect(text).toContain("▸ details (p)");
    const details = optionDetailText(q, 0);

    expect(details).toContain("## Description\n\nNo hosting required");
    expect(details).toContain("## Recommendation\n\n★ Recommendation rationale");
    expect(optionDetailText(q, 2)).toBeUndefined();
    expect(optionDetailText(request.questions[1], 0)).toBeUndefined();
  });
  it("shows completion and keeps the current tab visible at narrow widths", () => {
    let item = fresh();
    expect(progressLine(item, 0, 70, theme)).toContain("○ Target");
    item = transition(item, item.version, { type: "select", question: "target", option: "local" });
    expect(progressLine(item, 1, 70, theme)).toContain("✓ Target");
    const line = progressLine(item, 1, 24, theme);
    expect(line).toContain("Timing");
    expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });
  it("reviews answers without duplicated prompts, recommendations or empty notes", () => {
    let item = fresh();
    item = transition(item, item.version, { type: "select", question: "target", option: "local" });
    const text = reviewText(item);
    expect(text).toContain("1. Target");
    expect(text).toContain("✓ Local");
    expect(text).toContain("Answer required");
    expect(text).not.toContain(request.questions[0].question);
    expect(text).not.toContain("Recommendation");
    expect(text).not.toContain("Questionnaire note:");
  });
  it("compares only changed answers and notes without hiding multiline text", () => {
    let item = fresh();

    for (const [question, option] of [
      ["target", "local"],
      ["timing", "now"],
    ] as const)
      item = transition(item, item.version, { type: "select", question, option });
    item = transition(item, item.version, { type: "submit" });
    item = transition(item, item.version, {
      type: "reopen",
      base: 1,
      initiated_by: "user",
      mode: "async",
    });
    expect(diffText(item)).toContain("No answer changes");
    item = transition(item, item.version, {
      type: "note",
      question: "target",
      option: "local",
      text: "Line one\nLine two",
    });
    const text = diffText(item);
    expect(text).toContain("Target");
    expect(text).toContain("Line two");
    expect(text).not.toContain("Timing");
  });
  it("leads inbox rows with a title and meaningful progress, not internal IDs", () => {
    const item = fresh();
    expect(inboxLabel(item, 0)).toBe("1. Release plan · 0/2 answered · Draft");
    expect(inboxLabel(item, 0)).not.toContain(item.id);
    expect(inboxLabel(item, 1)).not.toBe(inboxLabel(item, 0));
  });
  it("keeps compact answers below a naturally sized context viewport", () => {
    const options = {
      title: "Title",
      header: "Choose one",
      footer: "enter Select · x Cancel\n↑↓ Move",
      closeKey: "esc",
      hint: "",
      rows: 30,
      width: 40,
      scroll: 0,
      theme,
    };

    const context = Array.from({ length: 30 }, (_, i) => `context ${i}`);
    const answers = ["Question?", "", "> ( ) Answer"];
    const first = renderQuestionView({ ...options, context, answers });

    expect(first.viewport.rows).toBe(7);
    expect(first.lines.join("\n")).toContain("context 0");
    expect(first.lines.join("\n")).toContain("> ( ) Answer");
    expect(first.lines.length).toBeLessThan(30);
    const last = renderQuestionView({ ...options, context, answers, scroll: 100 });
    expect(last.scroll).toBe(23);
    expect(last.lines.join("\n")).toContain("context 29");
    expect(last.lines.join("\n")).toContain("> ( ) Answer");
    expect(last.lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(
      renderQuestionView({ ...options, rows: 10, context, answers }).lines.join("\n"),
    ).toContain("too small");
    expect(
      renderQuestionView({ ...options, width: 20, context, answers }).lines.join("\n"),
    ).toContain("too small");
  });
  it("sizes conventional pages to content up to the normal cap", () => {
    const options = {
      title: "Title",
      header: "Details",
      footer: "escape Back\npageUp/pageDown Scroll",
      closeKey: "escape",
      hint: "",
      rows: 30,
      width: 40,
      scroll: 0,
      theme,
    };

    const short = renderScrollablePage({ ...options, body: ["one", "two"] });

    const long = renderScrollablePage({
      ...options,
      body: Array.from({ length: 30 }, (_, index) => `line ${index}`),
    });

    expect(short.lines.length).toBeLessThan(long.lines.length);
    expect(long.lines.length).toBeLessThanOrEqual(Math.floor(options.rows * 0.6));
    expect(long.viewport.rows).toBeGreaterThan(short.viewport.rows);
  });
  it("clips long written answers and notes to one line with a single ellipsis", () => {
    initTheme("dark");
    const item = fresh();
    const draft = item.draft?.answers.target;
    assert(draft);
    const a = { ...draft, custom: "word ".repeat(80), custom_selected: true };

    const text = displayText(optionLines(request.questions[0], a, 2, 40, theme).join("\n"));

    expect(text.match(/…/g)).toHaveLength(1);
    expect(text).not.toContain("...");
    expect(text.split("\n").filter((line) => line.includes("word"))).toHaveLength(1);
  });
  it("indents continuation lines of written answers in Review", () => {
    let item = fresh();
    item = transition(item, item.version, { type: "custom", question: "target", text: "one\ntwo" });
    expect(reviewText(item)).toContain("  ✓ one\n    two");
  });
});
