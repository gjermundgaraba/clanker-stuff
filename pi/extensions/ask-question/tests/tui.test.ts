import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { type Interaction, createInteraction, transition } from "../interaction.js";
import { QuestionnaireView } from "../tui/controller.js";
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Questionnaire } from "../request.js";
import { intent } from "../tui/input.js";

const plainQuestion = {
  id: "choice",
  header: "Choice",
  question: "Choose a target?",
  options: [
    { id: "first", label: "First", preview: "```ts\nconst value = 1;\n```" },
    { id: "second", label: "Second" },
  ],
};

const questionWithoutContext = {
  ...plainQuestion,
  recommendation: { option_ids: ["first"], reason: "Synthetic suggestion" },
};

const question = {
  ...questionWithoutContext,
  context: "## Context\nUnicode: 日本語 👩🏽‍💻",
};

function setup(
  multi = false,
  remap = false,
  request: Questionnaire = { questions: [{ ...question, multi_select: multi }] },
  prepare?: (item: Interaction) => Interaction,
) {
  initTheme("dark");
  let item = createInteraction("q_ui", request, "call", "async");
  let mutations = 0;

  if (prepare) item = prepare(item);
  const abort = new AbortController();
  const done = vi.fn();
  const report = vi.fn();
  const notify = vi.fn();
  const send = vi.fn<(revision: number) => void>();
  const tui = createMockTui({ rows: 30 });

  const keys = createKeybindings({
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.pageUp": [remap ? "alt+u" : "pageUp"],
    "tui.select.pageDown": [remap ? "alt+d" : "pageDown"],
    "tui.select.confirm": [remap ? "alt+y" : "enter"],
    "tui.select.cancel": ["escape"],
    "tui.input.submit": [remap ? "alt+d" : "enter"],
    "tui.input.newLine": [remap ? "alt+j" : "ctrl+j"],
  });

  const view = new QuestionnaireView(
    tui,
    createIdentityTheme(),
    keys,
    item,
    {
      current: () => item,
      mutate: (action) => {
        mutations++;

        return (item = transition(item, action));
      },
      subscribe: () => () => {},
      setFlush: () => {},
      blocking: false,
      notify,
      report,
      send,
    },
    done,
    abort.signal,
  );

  view.focused = true;

  const press = (...keys: string[]) => {
    for (const key of keys) view.handleInput(key);
  };

  return {
    view,
    done,
    send,
    notify,
    report,
    abort,
    tui,
    press,
    get item() {
      return item;
    },
    /** Checkpointed changes: viewing, scrolling and discarded editors make none. */
    get mutations() {
      return mutations;
    },
  };
}

describe("bounded questionnaire TUI", () => {
  it("shows context with compact detail markers while navigating with h/l", () => {
    const e = setup(false, false, {
      questions: [
        { ...question, multi_select: false },
        {
          ...plainQuestion,
          id: "plain",
          header: "Plain",
          options: [{ id: "a", label: "A" }],
        },
      ],
    });

    try {
      Object.defineProperty(e.tui.terminal, "rows", { value: 60, configurable: true });
      let screen = displayText(e.view.render(100).join("\n"));
      expect(screen).toContain("Unicode: 日本語 👩🏽‍💻");
      expect(screen.indexOf("Unicode:")).toBeLessThan(screen.indexOf(question.question));
      expect(screen).not.toContain("Context available");
      expect(screen).not.toContain("c Context");
      expect(screen).toContain("1. First\u00a0★  ▸ details (p)");
      expect(screen).not.toContain("Synthetic suggestion");
      expect(screen).toContain("x Cancel");
      expect(screen).toContain("h/l Questions");
      expect(screen).not.toContain("Help");
      expect(screen).not.toContain("const value");
      e.press("p");
      const details = displayText(e.view.render(100).join("\n"));
      expect(details).toContain("Synthetic suggestion");
      expect(details).toContain("const value");
      e.press("\u001b", "l");
      screen = displayText(e.view.render(100).join("\n"));
      expect(screen).toContain("> ( ) 1. A");
      expect(screen).not.toContain("Unicode:");
      expect(screen).not.toContain("preview (p)");
      e.press("h");
      expect(displayText(e.view.render(100).join("\n"))).toContain("Unicode:");
      e.press("1", "1");
      screen = e.view.render(100).join("\n");
      expect(screen).toContain("Send answers");
      expect(screen).toContain("Save without sending");
      expect(screen).toContain("Send starts/steers a turn");
    } finally {
      e.view.dispose();
    }
  });
  it("renders revision, form and current-question Markdown context in order", () => {
    const e = setup(
      false,
      false,
      {
        context: "**Shared constraints**",
        questions: [
          { ...question, context: "```ts\nconst local = 1;\n```" },
          { ...questionWithoutContext, id: "plain" },
        ],
      },
      (item) => {
        for (const q of item.request.questions)
          item = transition(item, {
            type: "select",
            question: q.id,
            option: "first",
          });
        item = transition(item, { type: "submit" });

        return transition(item, {
          type: "reopen",
          base: 1,
          initiated_by: "agent",
          mode: "async",
          reason: "New constraint",
        });
      },
    );

    try {
      Object.defineProperty(e.tui.terminal, "rows", { value: 80, configurable: true });
      e.press("1");
      const screen = displayText(e.view.render(120).join("\n"));

      const positions = [
        "Revision requested:",
        "New constraint",
        "Shared constraints",
        "const local = 1;",
        question.question,
      ].map((text) => screen.indexOf(text));

      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(screen).not.toContain("**Shared constraints**");
      expect(screen.split(question.question)).toHaveLength(2);
      e.press("l");
      const next = displayText(e.view.render(120).join("\n"));
      expect(next).toContain("Shared constraints");
      expect(next).toContain("New constraint");
      expect(next).not.toContain("const local");
    } finally {
      e.view.dispose();
    }
  });
  it("scrolls long context while keeping options and editors visible without changing answers", () => {
    const e = setup(true, false, {
      context: Array.from({ length: 40 }, (_, i) => `Context line ${i} 日本語 👩🏽‍💻`).join("\n\n"),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      const initial = displayText(e.view.render(80).join("\n"));
      expect(initial).toContain("Context line 0");
      expect(initial).toContain("> [ ] 1. First");
      e.press("pageDown");
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).not.toContain("Context line 0");
      expect(screen).toContain("> [ ] 1. First");
      e.press("pageUp");
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Context line 0");
      expect(screen).toContain("> [ ] 1. First");
      e.press("j");
      expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 2. Second");

      for (const [width, rows] of [
        [40, 20],
        [24, 14],
        [12, 8],
        [100, 60],
      ] as const) {
        Object.defineProperty(e.tui.terminal, "rows", { value: rows, configurable: true });
        const lines = e.view.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(rows);

        if (width >= 40 && rows >= 20)
          expect(displayText(lines.join("\n"))).toContain("> [ ] 2. Second");
      }

      expect(e.mutations).toBe(0);
      e.press("n", "Visible note");
      expect(displayText(e.view.render(100).join("\n"))).toContain("Visible note");
      e.press("\u001b");
      expect(displayText(e.view.render(100).join("\n"))).toContain("> [ ] 2. Second");
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });
  it("scrolls context with normalized fullscreen wheel events and leaves pinned answers visible", () => {
    const e = setup(true, false, {
      context: Array.from({ length: 40 }, (_, i) => `Mouse context ${i}`).join("\n\n"),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Mouse context 0");
      expect(screen).toContain("> [ ] 1. First");
      expect(
        e.view.handleMouse({
          type: "wheel",
          button: "none",
          x: 4,
          y: 4,
          screenX: 4,
          screenY: 4,
          width: 80,
          height: 30,
          shift: false,
          alt: false,
          ctrl: false,
          wheelDelta: 3,
        }),
      ).toEqual({ handled: true });
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).not.toContain("Mouse context 0");
      expect(screen).toContain("> [ ] 1. First");
    } finally {
      e.view.dispose();
    }
  });
  it.each([
    [20, "Context 1–1 / 33"],
    [30, "Context 1–5 / 33"],
  ])("pages directly between context endpoints at %i terminal rows", (rows, firstRange) => {
    const e = setup(false, false, {
      context: Array.from({ length: 15 }, (_, i) => `Context entry ${i}`).join("\n\n"),
      questions: [question],
    });

    try {
      Object.defineProperty(e.tui.terminal, "rows", { value: rows, configurable: true });
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain(firstRange);
      expect(screen).toContain("Context entry 0");
      expect(screen).toContain("> ( ) 1. First");

      e.press(...Array.from({ length: 40 }, () => "pageDown"));
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain(rows === 20 ? "Context 33–33 / 33" : "Context 29–33 / 33");
      expect(screen).toContain("Unicode:");
      expect(screen).toContain("> ( ) 1. First");

      e.press(...Array.from({ length: 40 }, () => "pageUp"));
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain(firstRange);
      expect(screen).toContain("Context entry 0");
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });
  it("uses the resized context viewport when paging", () => {
    const e = setup(false, false, {
      context: Array.from({ length: 15 }, (_, i) => `Context entry ${i}`).join("\n\n"),
      questions: [question],
    });

    try {
      e.view.render(80);
      e.press("j", ...Array.from({ length: 40 }, () => "pageDown"));
      expect(displayText(e.view.render(80).join("\n"))).toContain("Context 29–33 / 33");

      Object.defineProperty(e.tui.terminal, "rows", { value: 18, configurable: true });
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Context 29–29 / 33");
      expect(screen).toContain("Context entry 14");
      expect(screen).toContain("> ( ) 2. Second");

      e.press("pageDown", "pageDown", "pageDown", "pageDown");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Context 33–33 / 33");
      e.press("pageUp", "pageUp");
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Context 31–31 / 33");
      expect(screen).toContain("> ( ) 2. Second");
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });
  it.each([false, true])("advertises configured scrolling keys (remapped: %s)", (remap) => {
    const e = setup(false, remap, {
      context: "Long context\n\n".repeat(40),
      questions: [question],
    });

    try {
      const up = remap ? "alt+u" : "pageUp";
      const down = remap ? "alt+d" : "pageDown";

      for (const width of [40, 80, 120]) {
        const screen = displayText(e.view.render(width).join("\n"));
        expect(screen).toContain(`${up}/${down} Context`);
      }

      e.press(up);
      const top = e.view.render(80);
      e.press(down);
      expect(e.view.render(80)).not.toEqual(top);
      e.press(up);
      expect(e.view.render(80)).toEqual(top);
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });
  it.each(["\u001b", "\r", "h"])("reveals the answer after closing a preview with %j", (close) => {
    const e = setup(true, false, {
      context: "Long context\n\n".repeat(40),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      e.view.render(80);
      e.press("k");
      expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 1. First");
      e.press("p");
      expect(displayText(e.view.render(80).join("\n"))).toContain("const value");
      e.press(close);
      expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 1. First");
      expect(e.mutations).toBe(0);
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it.each(["\u001b", "\r"])("reveals the answer after leaving a note with %j", (close) => {
    const e = setup(true, false, {
      context: "Long context\n\n".repeat(40),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      e.view.render(80);
      e.press("j");
      e.view.render(80);
      e.press("n", "Answer note");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Answer note");
      e.press(close);
      expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 2. Second");
      expect(e.item.draft?.answers.choice?.notes.second).toBe(close === "\r" ? "Answer note" : "");
      expect(e.item.draft?.answers.choice?.selected).toEqual([]);
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("reveals number-key selections and retains focus across a narrow resize", () => {
    const e = setup(true, false, {
      questions: [
        {
          ...question,
          multi_select: true,
          options: Array.from({ length: 5 }, (_, i) => ({
            id: `o${i}`,
            label: `Choice ${i}`,
            description: "日本語 details ".repeat(12),
          })),
          recommendation: { option_ids: ["o0"], reason: "Synthetic" },
        },
      ],
    });

    try {
      Object.defineProperty(e.tui.terminal, "rows", { value: 40, configurable: true });
      e.view.render(80);
      e.press("5");
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(screen).not.toContain("日本語 details");
      e.press("p");
      expect(displayText(e.view.render(80).join("\n"))).toContain("日本語 details");
      e.press("\u001b");
      Object.defineProperty(e.tui.terminal, "rows", { value: 20, configurable: true });
      const lines = e.view.render(40);
      screen = displayText(lines.join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(screen).not.toContain("Terminal too small");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(e.item.draft?.answers.choice?.selected).toEqual(["o4"]);
    } finally {
      e.view.dispose();
    }
  });
  it("uses j/k to highlight without selecting, but keeps editor text and Review k intact", () => {
    const e = setup();

    try {
      e.press("j");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 2. Second");
      e.press("k");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 1. First");
      expect(e.mutations).toBe(0);
      e.press("g", "jk", "\r", "j", "\r", "k");
      expect(e.item.submissions[0]?.answers.choice?.selections[0]?.option_id).toBe("second");
      expect(e.item.submissions[0]?.note).toBe("jk");
      expect(e.send).not.toHaveBeenCalled();
      expect(intent(createKeybindings({ "tui.select.confirm": ["k"] }), "k", true)).toBe("confirm");
    } finally {
      e.view.dispose();
    }
  });
  it("keeps highlight/context/preview view-only and requires Review then explicit submission", () => {
    const e = setup();

    try {
      e.press("p");
      expect(e.mutations).toBe(0);
      expect(displayText(e.view.render(80).join("\n"))).toContain("const value");
      e.press("\u001b", "\u001b[B", "p"); // No preview on this option: nothing opens.
      expect(displayText(e.view.render(80).join("\n"))).toContain("> ( ) 2. Second");
      const before = e.view.render(80);
      e.press("c");
      expect(e.view.render(80)).toEqual(before);
      expect(e.mutations).toBe(0);
      e.press("1");
      expect(e.done).not.toHaveBeenCalled();
      expect(e.view.render(80).join("\n")).toContain("Review");
      e.press("\r", "\r");
      expect(e.item.submissions).toHaveLength(1);
      expect(e.send).toHaveBeenCalledOnce();
    } finally {
      e.view.dispose();
    }
  });
  it("preserves distinct option notes across deselection and adds an overall note", () => {
    const e = setup(true);

    try {
      e.press(
        "n",
        "first note",
        "\r",
        "1",
        "2",
        "n",
        "second note",
        "\r",
        "1",
        "1",
        "g",
        "whole form",
        "\r",
        "r",
        "k",
      );
      expect(e.item.submissions[0]?.answers.choice?.selections).toEqual([
        { option_id: "second", label: "Second", note: "second note" },
        { option_id: "first", label: "First", note: "first note" },
      ]);
      expect(e.item.submissions[0]?.note).toBe("whole form");
      expect(e.send).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("uses remapped multiline completion, treats digits/paste as editor text, and never submits from an editor", () => {
    const e = setup(false, true);

    try {
      e.press(
        "\u001b[B",
        "\u001b[B",
        "\u001by",
        "123",
        "\u001bj",
        "\u001b[200~r1s\u001b[201~",
        "\u001bd",
      );
      expect(e.item.draft?.answers.choice?.custom).toBe("123\nr1s");
      expect(e.done).not.toHaveBeenCalled();
      e.press("r", "k");
      expect(e.item.submissions[0]?.answers.choice?.custom?.text).toBe("123\nr1s");
    } finally {
      e.view.dispose();
    }
  });
  it("reselects a saved custom answer without requiring a text change", () => {
    const e = setup();

    try {
      e.press(
        "\u001b[B",
        "\u001b[B",
        "\r",
        "Saved alternative",
        "\r",
        "1",
        "\u001b[D",
        "\u001b[B",
        "\u001b[B",
        "\r",
        "\r",
        "r",
        "k",
      );
      expect(e.item.submissions[0]?.answers.choice).toMatchObject({
        selections: [],
        custom: { text: "Saved alternative" },
      });
    } finally {
      e.view.dispose();
    }
  });
  it("retains over-limit text and bounds Unicode/Markdown across resize", () => {
    const e = setup();

    try {
      e.press("p");

      for (const [width, rows] of [
        [80, 30],
        [24, 14],
        [12, 8],
        [100, 60],
      ] as const) {
        Object.defineProperty(e.tui.terminal, "rows", { value: rows, configurable: true });
        const lines = e.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }

      e.press("\u001b", "g");
      e.view.handleInput("日".repeat(1001));
      expect(() => e.view.flush()).toThrow("limit");
      expect(e.item.draft?.note).toBe("");
      Object.defineProperty(e.tui.terminal, "rows", { value: 40, configurable: true });
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      e.press("\r"); // Over-limit text cannot be saved, so the editor stays open.
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      expect(e.view.render(80).join("\n")).toContain("limit");
      e.press("\u001b"); // Discarding is always possible.
      expect(e.view.render(80).join("\n")).not.toContain("1001/1000");
      expect(e.item.draft?.note).toBe("");
    } finally {
      e.view.dispose();
    }
  });
  it("saves a written answer with Enter and advances, discards it with Escape", () => {
    const e = setup();

    try {
      e.press("\u001b[B", "\u001b[B", "\r", "typed then dropped", "\u001b");
      expect(e.item.draft?.answers.choice?.custom).toBe("");
      expect(e.item.draft?.answers.choice?.custom_selected).toBe(false);
      expect(e.view.render(80).join("\n")).toContain("Write answer");
      e.press("\r", "kept", "\r");
      expect(e.item.draft?.answers.choice).toMatchObject({ custom: "kept", custom_selected: true });
      expect(e.view.render(80).join("\n")).toContain("Send answers");
      e.press("1");
      expect(e.view.render(80).join("\n")).toContain("> (•) Write another answer");
      expect(e.view.render(80).join("\n")).toContain("Edit answer · → Next");
      e.press("\r", "\u001b");
      expect(e.item.draft?.answers.choice?.custom).toBe("kept");
      expect(e.view.render(80).join("\n")).not.toContain("Send answers");
    } finally {
      e.view.dispose();
    }
  });
  it("edits notes and written answers in a focused editor view", () => {
    const e = setup();

    try {
      e.press("j", "n", "inline note");
      const editor = displayText(e.view.render(80).join("\n"));
      expect(editor).toContain("Note · Second");
      expect(editor).toContain("inline note");
      expect(editor).not.toContain("( ) 1. First");
      expect(editor).toContain("11/1000");
      expect(editor).toContain("Save");
      e.press("\r");
      expect(e.item.draft?.answers.choice?.notes.second).toBe("inline note");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Note: inline note");
      e.press("g", "overall");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Questionnaire note");
      e.press("\r");
      e.press("pageDown");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Questionnaire note: overall");
    } finally {
      e.view.dispose();
    }
  });
  it("cancels only on a repeated x and notifies when answers are kept unsent", () => {
    const e = setup();

    try {
      e.press("x");
      expect(e.view.render(80).join("\n")).toContain("Press x again");
      e.press("1");
      expect(e.item.cancelled).toBe(false);
      expect(e.view.render(80).join("\n")).not.toContain("Press x again");
      e.press("k");
      expect(e.notify).toHaveBeenCalledWith(expect.stringContaining("not sent"));
      expect(e.send).not.toHaveBeenCalled();
      expect(e.done).toHaveBeenCalledWith("submitted");
    } finally {
      e.view.dispose();
    }
  });
  it("opens on the first unanswered question with the current answer highlighted", () => {
    const e = setup(false, false, {
      questions: [
        { ...question, id: "first_q", multi_select: false },
        { ...question, id: "second_q", header: "Second question" },
      ],
    });

    try {
      e.press("2", "\u001b[D");
      expect(e.view.render(80).join("\n")).toContain("> (•) 2. Second");
      e.press("x", "x");
      expect(e.item.cancelled).toBe(true);
    } finally {
      e.view.dispose();
    }
  });
  it("closes after failed delivery while retaining the submitted revision in the inbox", () => {
    const e = setup();

    try {
      e.send.mockImplementation(() => {
        throw new Error("handoff failed");
      });
      e.press("1", "\r");
      expect(e.item.submissions).toHaveLength(1);
      expect(e.done).toHaveBeenCalledWith("submitted");
      expect(e.report).toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
});
