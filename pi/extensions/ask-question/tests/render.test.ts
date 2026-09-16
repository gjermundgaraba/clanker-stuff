import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";
import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { createInteraction, transition } from "../interaction.js";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import {
  boundedView,
  detailLines,
  diffText,
  inboxLabel,
  optionLines,
  progressLine,
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
  ],
};
const fresh = () => createInteraction("q_private_identifier", request, "call", "async");
const theme = createIdentityTheme();

describe("questionnaire presentation", () => {
  it("lists compact options with focus, selection, note excerpts and inline editors", () => {
    initTheme("dark");
    const item = fresh();
    const q = item.request.questions[0];
    const a = item.draft!.answers.target;
    a.selected = ["cloud"];
    a.notes.local = "Keep the local data\nSecond line";
    const result = optionLines(q, a, 0, 60, theme);
    const text = displayText(result.lines.join("\n"));
    expect(text).toContain("> ( ) 1. Local\u00a0★");
    expect(text).toContain("  (•) 2. Cloud");
    expect(text).toContain("Note: Keep the local data …");
    expect(text).not.toContain("Second line");
    expect(text).not.toContain("No hosting required"); // Descriptions live in Details.
    expect(result.focusLine).toBe(0);
    expect(result.focusEnd).toBe(1);
    expect(optionLines({ ...q, multi_select: true }, a, 1, 60, theme).lines.join("\n")).toContain(
      "[x] 2. Cloud",
    );
    const inline = optionLines(q, a, 0, 60, theme, { choice: 0, lines: ["EDITOR"] }).lines;
    expect(inline[1]).toBe("    EDITOR");
    expect(inline.join("\n")).not.toContain("Note:");
    const details = displayText(detailLines(q, a, 0, 60, theme).join("\n"));
    expect(details).toContain("Details");
    expect(details).toContain("No hosting required");
    expect(details).toContain("★ Recommended: Recommendation rationale");
    expect(detailLines(q, a, 2, 60, theme).join("\n")).toContain("Enter your own response");
    expect(detailLines(item.request.questions[1], a, 0, 60, theme)).toEqual([]);
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
    ])
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
  it("sizes the frame to its content within the budget and scrolls only to reveal focus", () => {
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
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const first = boundedView({ ...options, body, focusLine: 0 });
    const short = boundedView({ ...options, body: ["Short"] });
    expect(short.lines.length).toBeLessThan(first.lines.length);
    expect(short.lines.filter((line) => line === "")).toHaveLength(2);
    expect(short.lines[0]).toContain("─ Title ─");
    expect(short.lines.at(-1)).toMatch(/^─+$/);
    expect(short.lines[1]).toBe("Choose one");
    expect(boundedView({ ...options, body, focusLine: 2 }).scroll).toBe(0);
    const last = boundedView({ ...options, body, focusLine: 28 });
    expect(last.lines.join("\n")).toContain("line 28");
    expect(last.lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(last.lines.length).toBeLessThanOrEqual(18);
    expect(boundedView({ ...options, width: 20, body }).lines.join("\n")).toContain("too small");
  });
  it("clips long written answers and notes to one line with a single ellipsis", () => {
    initTheme("dark");
    const item = fresh();
    const a = { ...item.draft!.answers.target, custom: "word ".repeat(80), custom_selected: true };
    const text = displayText(
      optionLines(item.request.questions[0], a, 2, 40, theme).lines.join("\n"),
    );
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
