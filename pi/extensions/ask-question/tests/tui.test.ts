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
  beforeMutation?: () => Promise<void>,
  request: Questionnaire = { questions: [{ ...question, multi_select: multi }] },
  prepare?: (item: Interaction) => Interaction,
) {
  initTheme("dark");
  let item = createInteraction("q_ui", request, "call", "async");

  if (prepare) item = prepare(item);
  const abort = new AbortController();
  const done = vi.fn();
  const report = vi.fn();
  const notify = vi.fn();
  const send = vi.fn(async () => {});
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
      current: () => structuredClone(item),
      mutate: async (version, action) => {
        await beforeMutation?.();

        return (item = transition(item, version, action));
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

  const press = async (...keys: string[]) => {
    for (const key of keys) {
      view.handleInput(key);
      await view.settled();
    }
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
    pause: () => {
      item = transition(item, item.version, { type: "pause" });
    },
  };
}

describe("bounded questionnaire TUI", () => {
  it("shows context inline and advertises previews while navigating with h/l", async () => {
    const e = setup(false, false, undefined, {
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
      expect(screen).toContain("1. First\u00a0★  ▸ preview (p)");
      expect(screen).toContain("▸ Markdown preview available · p");
      expect(screen).toContain("★ Recommended: Synthetic suggestion");
      expect(screen).toContain("x Cancel");
      expect(screen).toContain("h/l Questions");
      expect(screen).not.toContain("Help");
      expect(screen).not.toContain("const value");
      await e.press("p");
      expect(displayText(e.view.render(100).join("\n"))).toContain("const value");
      await e.press("\u001b", "l");
      screen = displayText(e.view.render(100).join("\n"));
      expect(screen).toContain("> ( ) 1. A");
      expect(screen).not.toContain("Unicode:");
      expect(screen).not.toContain("preview (p)");
      await e.press("h");
      expect(displayText(e.view.render(100).join("\n"))).toContain("Unicode:");
      await e.press("1", "1");
      screen = e.view.render(100).join("\n");
      expect(screen).toContain("Send answers");
      expect(screen).toContain("Save without sending");
      expect(screen).toContain("Send starts/steers a turn");
    } finally {
      e.view.dispose();
    }
  });
  it("renders revision, form and current-question Markdown context in order", async () => {
    const e = setup(
      false,
      false,
      undefined,
      {
        context: "**Shared constraints**",
        questions: [
          { ...question, context: "```ts\nconst local = 1;\n```" },
          { ...questionWithoutContext, id: "plain" },
        ],
      },
      (item) => {
        for (const q of item.request.questions)
          item = transition(item, item.version, {
            type: "select",
            question: q.id,
            option: "first",
          });
        item = transition(item, item.version, { type: "submit" });

        return transition(item, item.version, {
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
      await e.press("1");
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
      await e.press("l");
      const next = displayText(e.view.render(120).join("\n"));
      expect(next).toContain("Shared constraints");
      expect(next).toContain("New constraint");
      expect(next).not.toContain("const local");
    } finally {
      e.view.dispose();
    }
  });
  it("scrolls long inline context and reveals options and editors without changing answers", async () => {
    const e = setup(true, false, undefined, {
      context: Array.from({ length: 40 }, (_, i) => `Context line ${i} 日本語 👩🏽‍💻`).join("\n\n"),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      const initial = displayText(e.view.render(80).join("\n"));
      expect(initial).toContain("Context line 0");
      expect(initial).not.toContain("1. First");
      await e.press("pageDown");
      expect(displayText(e.view.render(80).join("\n"))).not.toContain("Context line 0");
      await e.press("pageUp");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Context line 0");
      await e.press("j");
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
        expect(lines.length).toBeLessThanOrEqual(Math.max(3, Math.floor(rows * 0.6)));

        if (width >= 40) expect(displayText(lines.join("\n"))).toContain("> [ ] 2. Second");
      }

      expect(e.item.version).toBe(1);
      await e.press("n", "Visible note");
      expect(displayText(e.view.render(100).join("\n"))).toContain("Visible note");
      await e.press("\u001b");
      expect(displayText(e.view.render(100).join("\n"))).toContain("> [ ] 2. Second");
      expect(e.item.version).toBe(1);
    } finally {
      e.view.dispose();
    }
  });
  it.each([14, 15, 18, 19, 20, 30])(
    "pages through every context line in both directions at %i terminal rows",
    async (rows) => {
      const expected = Array.from({ length: 15 }, (_, i) => i);

      const e = setup(false, false, undefined, {
        context: expected.map((i) => `Context entry ${i}`).join("\n\n"),
        questions: [question],
      });

      try {
        Object.defineProperty(e.tui.terminal, "rows", { value: rows, configurable: true });

        for (const key of ["pageDown", "pageUp"]) {
          const seen = new Set<number>();
          let screen = displayText(e.view.render(80).join("\n"));

          for (let page = 0; page < 100; page++) {
            for (const match of screen.matchAll(/Context entry (\d+)/g)) seen.add(Number(match[1]));
            await e.press(key);
            const next = displayText(e.view.render(80).join("\n"));

            if (next === screen) break;
            screen = next;
          }

          expect([...seen].sort((a, b) => a - b)).toEqual(expected);
        }

        expect(e.item.version).toBe(1);
      } finally {
        e.view.dispose();
      }
    },
  );
  it("uses the resized body height when paging back through context", async () => {
    const expected = Array.from({ length: 15 }, (_, i) => i);

    const e = setup(false, false, undefined, {
      context: expected.map((i) => `Context entry ${i}`).join("\n\n"),
      questions: [question],
    });

    try {
      e.view.render(80);
      await e.press("j");
      e.view.render(80);
      Object.defineProperty(e.tui.terminal, "rows", { value: 18, configurable: true });
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("> ( ) 2. Second");
      const seen = new Set<number>();

      for (let page = 0; page < 100; page++) {
        for (const match of screen.matchAll(/Context entry (\d+)/g)) seen.add(Number(match[1]));
        await e.press("pageUp");
        const next = displayText(e.view.render(80).join("\n"));

        if (next === screen) break;
        screen = next;
      }

      expect([...seen].sort((a, b) => a - b)).toEqual(expected);
      expect(e.item.version).toBe(1);
    } finally {
      e.view.dispose();
    }
  });
  it.each([false, true])("advertises configured scrolling keys (remapped: %s)", async (remap) => {
    const e = setup(false, remap, undefined, {
      context: "Long context\n\n".repeat(40),
      questions: [question],
    });

    try {
      const up = remap ? "alt+u" : "pageUp";
      const down = remap ? "alt+d" : "pageDown";

      for (const width of [40, 80, 120]) {
        const screen = displayText(e.view.render(width).join("\n"));
        expect(screen).toContain(`${up}/${down} Scroll`);
      }

      await e.press(up);
      const top = e.view.render(80);
      await e.press(down);
      expect(e.view.render(80)).not.toEqual(top);
      await e.press(up);
      expect(e.view.render(80)).toEqual(top);
      expect(e.item.version).toBe(1);
    } finally {
      e.view.dispose();
    }
  });
  it.each(["\u001b", "\r", "h"])(
    "reveals the answer after closing a preview with %j",
    async (close) => {
      const e = setup(true, false, undefined, {
        context: "Long context\n\n".repeat(40),
        questions: [{ ...question, multi_select: true }],
      });

      try {
        e.view.render(80);
        await e.press("k");
        expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 1. First");
        await e.press("p");
        expect(displayText(e.view.render(80).join("\n"))).toContain("const value");
        await e.press(close);
        expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 1. First");
        expect(e.item.version).toBe(1);
        expect(e.done).not.toHaveBeenCalled();
      } finally {
        e.view.dispose();
      }
    },
  );
  it.each(["\u001b", "\r"])("reveals the answer after leaving a note with %j", async (close) => {
    const e = setup(true, false, undefined, {
      context: "Long context\n\n".repeat(40),
      questions: [{ ...question, multi_select: true }],
    });

    try {
      e.view.render(80);
      await e.press("j");
      e.view.render(80);
      await e.press("n", "Answer note");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Answer note");
      await e.press(close);
      expect(displayText(e.view.render(80).join("\n"))).toContain("> [ ] 2. Second");
      expect(e.item.draft?.answers.choice?.notes.second).toBe(close === "\r" ? "Answer note" : "");
      expect(e.item.draft?.answers.choice?.selected).toEqual([]);
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("keeps the frame height stable between questions and views", async () => {
    const e = setup(false, false, undefined, {
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
      const first = e.view.render(100).length;
      await e.press("l");
      expect(`l:${e.view.render(100).length}`).toBe(`l:${first}`);
      await e.press("1");
      expect(`review:${e.view.render(100).length}`).toBe(`review:${first}`);
      await e.press("i");
      expect(`detail:${e.view.render(100).length}`).toBe(`detail:${first}`);
    } finally {
      e.view.dispose();
    }
  });
  it("reveals number-key selections and retains focus across a narrow resize", async () => {
    const e = setup(true, false, undefined, {
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
      await e.press("5");
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(screen).toContain("日本語 details");
      Object.defineProperty(e.tui.terminal, "rows", { value: 20, configurable: true });
      const lines = e.view.render(40);
      screen = displayText(lines.join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(e.item.draft?.answers.choice?.selected).toEqual(["o4"]);
    } finally {
      e.view.dispose();
    }
  });
  it("uses j/k to highlight without selecting, but keeps editor text and Review k intact", async () => {
    const e = setup();

    try {
      await e.press("j");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 2. Second");
      await e.press("k");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 1. First");
      expect(e.item.version).toBe(1);
      await e.press("g", "jk", "\r", "j", "\r", "k");
      expect(e.item.submissions[0]?.answers.choice?.selections[0]?.option_id).toBe("second");
      expect(e.item.submissions[0]?.note).toBe("jk");
      expect(e.send).not.toHaveBeenCalled();
      expect(intent(createKeybindings({ "tui.select.confirm": ["k"] }), "k", true)).toBe("confirm");
    } finally {
      e.view.dispose();
    }
  });
  it("keeps input ordered while a note checkpoint is still in flight", async () => {
    const started = Promise.withResolvers<void>();
    const checkpoint = Promise.withResolvers<void>();

    const e = setup(false, false, async () => {
      started.resolve();
      await checkpoint.promise;
    });

    try {
      await e.press("n");
      e.view.handleInput("Checkpointed note");
      e.view.handleInput("\r");
      await started.promise;
      e.view.handleInput("2");
      expect(e.item.draft?.answers.choice?.selected).toEqual([]);
      checkpoint.resolve();
      await e.view.flush();
      expect(e.item.draft?.answers.choice?.notes.first).toBe("Checkpointed note");
      expect(e.item.draft?.answers.choice?.selected).toEqual(["second"]);
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      checkpoint.resolve();
      e.view.dispose();
    }
  });
  it("routes rapid keys after saving a note to the form, not the outgoing editor", async () => {
    const e = setup();

    try {
      await e.press("n");

      for (const key of ["Synthetic note", "\r", "2", "r"]) e.view.handleInput(key);
      await e.view.flush();
      expect(e.item.draft?.answers.choice?.notes.first).toBe("Synthetic note");
      expect(e.item.draft?.answers.choice?.selected).toEqual(["second"]);
      expect(e.view.render(80).join("\n")).toContain("Send answers");
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("routes a rapid editor-open, paste, newline and completion burst in order", async () => {
    const e = setup(false, true);

    try {
      for (const key of [
        "g",
        "\u001b[200~123rs\u001b[201~",
        "\u001bj",
        "next line",
        "\u001bd",
        "2",
      ])
        e.view.handleInput(key);
      await e.view.flush();
      expect(e.item.draft?.note).toBe("123rs\nnext line");
      expect(e.item.draft?.answers.choice?.selected).toEqual(["second"]);
      expect(e.done).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("keeps highlight/context/preview view-only and requires Review then explicit submission", async () => {
    const e = setup();

    try {
      await e.press("p");
      expect(e.item.version).toBe(1);
      expect(displayText(e.view.render(80).join("\n"))).toContain("const value");
      await e.press("\u001b", "\u001b[B", "p"); // No preview on this option: nothing opens.
      expect(displayText(e.view.render(80).join("\n"))).toContain("> ( ) 2. Second");
      const before = e.view.render(80);
      await e.press("c");
      expect(e.view.render(80)).toEqual(before);
      expect(e.item.version).toBe(1);
      await e.press("1");
      expect(e.done).not.toHaveBeenCalled();
      expect(e.view.render(80).join("\n")).toContain("Review");
      await e.press("\r", "\r");
      expect(e.item.submissions).toHaveLength(1);
      expect(e.send).toHaveBeenCalledOnce();
    } finally {
      e.view.dispose();
    }
  });
  it("preserves distinct option notes across deselection and adds an overall note", async () => {
    const e = setup(true);

    try {
      await e.press(
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
  it("uses remapped multiline completion, treats digits/paste as editor text, and never submits from an editor", async () => {
    const e = setup(false, true);

    try {
      await e.press(
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
      await e.press("r", "k");
      expect(e.item.submissions[0]?.answers.choice?.custom?.text).toBe("123\nr1s");
    } finally {
      e.view.dispose();
    }
  });
  it("reselects a saved custom answer without requiring a text change", async () => {
    const e = setup();

    try {
      await e.press(
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
  it("flushes uncheckpointed typing on Stop, rebasing only unchanged drafts", async () => {
    const e = setup();

    try {
      await e.press("g");
      e.view.handleInput("last keystrokes");
      e.pause();
      e.abort.abort();
      await expect.poll(() => e.done.mock.calls.length).toBe(1);
      expect(e.item.draft?.note).toBe("last keystrokes");
      expect(e.item.paused).toBe(true);
      expect(e.report).not.toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
  it("retains over-limit text and bounds Unicode/Markdown across resize", async () => {
    const e = setup();

    try {
      await e.press("p");

      for (const [width, rows] of [
        [80, 30],
        [24, 14],
        [12, 8],
        [100, 60],
      ] as const) {
        Object.defineProperty(e.tui.terminal, "rows", { value: rows, configurable: true });
        const lines = e.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.max(3, Math.floor(rows * 0.6)));
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }

      await e.press("\u001b", "g");
      e.view.handleInput("日".repeat(1001));
      await expect(e.view.flush()).rejects.toThrow("limit");
      expect(e.item.draft?.note).toBe("");
      Object.defineProperty(e.tui.terminal, "rows", { value: 40, configurable: true });
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      await e.press("\r"); // Over-limit text cannot be saved, so the editor stays open.
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      expect(e.view.render(80).join("\n")).toContain("limit");
      await e.press("\u001b"); // Discarding is always possible.
      expect(e.view.render(80).join("\n")).not.toContain("1001/1000");
      expect(e.item.draft?.note).toBe("");
    } finally {
      e.view.dispose();
    }
  });
  it("saves a written answer with Enter and advances, discards it with Escape", async () => {
    const e = setup();

    try {
      await e.press("\u001b[B", "\u001b[B", "\r", "typed then dropped", "\u001b");
      expect(e.item.draft?.answers.choice?.custom).toBe("");
      expect(e.item.draft?.answers.choice?.custom_selected).toBe(false);
      expect(e.view.render(80).join("\n")).toContain("Write answer");
      await e.press("\r", "kept", "\r");
      expect(e.item.draft?.answers.choice).toMatchObject({ custom: "kept", custom_selected: true });
      expect(e.view.render(80).join("\n")).toContain("Send answers");
      await e.press("1");
      expect(e.view.render(80).join("\n")).toContain("> (•) Write another answer");
      expect(e.view.render(80).join("\n")).toContain("Edit answer · → Next");
      await e.press("\r", "\u001b");
      expect(e.item.draft?.answers.choice?.custom).toBe("kept");
      expect(e.view.render(80).join("\n")).not.toContain("Send answers");
    } finally {
      e.view.dispose();
    }
  });
  it("edits notes and written answers inline, keeping the option list visible", async () => {
    const e = setup();

    try {
      await e.press("j", "n", "inline note");
      const lines = displayText(e.view.render(80).join("\n")).split("\n");
      const option = lines.findIndex((line) => line.includes("> ( ) 2. Second"));
      expect(option).toBeGreaterThan(0);
      expect(lines.slice(option + 1, option + 4).join("\n")).toContain("inline note");
      expect(lines.join("\n")).toContain("( ) 1. First");
      expect(lines.join("\n")).toContain("11/1000");
      expect(lines.join("\n")).toContain("Save");
      await e.press("\r");
      expect(e.item.draft?.answers.choice?.notes.second).toBe("inline note");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Note: inline note");
      await e.press("g", "overall");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Questionnaire note");
      await e.press("\r");
      await e.press("pageDown");
      expect(displayText(e.view.render(80).join("\n"))).toContain("Questionnaire note: overall");
    } finally {
      e.view.dispose();
    }
  });
  it("cancels only on a repeated x and notifies when answers are kept unsent", async () => {
    const e = setup();

    try {
      await e.press("x");
      expect(e.view.render(80).join("\n")).toContain("Press x again");
      await e.press("1");
      expect(e.item.cancelled).toBe(false);
      expect(e.view.render(80).join("\n")).not.toContain("Press x again");
      await e.press("k");
      expect(e.notify).toHaveBeenCalledWith(expect.stringContaining("not sent"));
      expect(e.send).not.toHaveBeenCalled();
      expect(e.done).toHaveBeenCalledWith("submitted");
    } finally {
      e.view.dispose();
    }
  });
  it("opens on the first unanswered question with the current answer highlighted", async () => {
    const e = setup(false, false, undefined, {
      questions: [
        { ...question, id: "first_q", multi_select: false },
        { ...question, id: "second_q", header: "Second question" },
      ],
    });

    try {
      await e.press("2", "\u001b[D");
      expect(e.view.render(80).join("\n")).toContain("> (•) 2. Second");
      await e.press("x", "x");
      expect(e.item.cancelled).toBe(true);
    } finally {
      e.view.dispose();
    }
  });
  it("closes after failed delivery while retaining the submitted revision in the inbox", async () => {
    const e = setup();

    try {
      e.send.mockRejectedValue(new Error("handoff failed"));
      await e.press("1", "\r");
      expect(e.item.submissions).toHaveLength(1);
      expect(e.done).toHaveBeenCalledWith("submitted");
      expect(e.report).toHaveBeenCalled();
    } finally {
      e.view.dispose();
    }
  });
});
