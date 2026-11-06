import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { outcome } from "../delivery.js";
import type { Outcome } from "../delivery.js";
import {
  collectAnswers,
  createInteraction,
  transition,
} from "../interaction.js";
import type { Questionnaire } from "../request.js";
import { QuestionnaireView } from "../tui/controller.js";
import type { FormResult } from "../tui/controller.js";
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

const setup = (
  multi = false,
  remap = false,
  request?: Omit<Questionnaire, "wait">
) => {
  initTheme("dark");

  let item = createInteraction("q_ui", {
    wait: false,
    ...(request ?? { questions: [{ ...question, multi_select: multi }] }),
  });

  let mutations = 0;
  let result: Outcome | undefined;
  const abort = new AbortController();
  const done = vi.fn<(form: FormResult) => void>();
  const report = vi.fn<(cause: unknown) => void>();

  const finish = vi.fn<(kind: "submit" | "dismiss") => Outcome>((kind) => {
    const answers = kind === "submit" ? collectAnswers(item) : undefined;
    item = transition(item, { type: kind });
    result = outcome(
      item,
      kind === "submit" ? "answered" : "dismissed",
      answers
    );

    return result;
  });

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
        mutations += 1;

        return (item = transition(item, action));
      },
      subscribe: () => () => {},
      setFlush: () => {},
      finish,
      waiting: false,
      report,
    },
    done,
    abort.signal
  );

  view.focused = true;

  const press = (...inputs: string[]) => {
    for (const input of inputs) {
      view.handleInput(input);
    }
  };

  return {
    view,
    done,
    finish,
    report,
    abort,
    tui,
    press,
    get item() {
      return item;
    },
    get mutations() {
      return mutations;
    },
    get outcome() {
      return result;
    },
  };
};

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
      Object.defineProperty(e.tui.terminal, "rows", {
        value: 60,
        configurable: true,
      });
      let screen = displayText(e.view.render(100).join("\n"));
      expect(screen).toContain("Unicode: 日本語 👩🏽‍💻");
      expect(screen.indexOf("Unicode:")).toBeLessThan(
        screen.indexOf(question.question)
      );
      expect(screen).not.toContain("Context available");
      expect(screen).not.toContain("c Context");
      expect(screen).toContain("1. First\u00A0★  ▸ details (p)");
      expect(screen).not.toContain("Synthetic suggestion");
      expect(screen).toContain("d Dismiss");
      expect(screen).toContain("h/l Questions");
      expect(screen).not.toContain("Help");
      expect(screen).not.toContain("const value");
      e.press("p");
      const details = displayText(e.view.render(100).join("\n"));
      expect(details).toContain("Synthetic suggestion");
      expect(details).toContain("const value");
      e.press("\u001B", "l");
      screen = displayText(e.view.render(100).join("\n"));
      expect(screen).toContain("> ( ) 1. A");
      expect(screen).not.toContain("Unicode:");
      expect(screen).not.toContain("preview (p)");
      e.press("h");
      expect(displayText(e.view.render(100).join("\n"))).toContain("Unicode:");
      e.press("1", "1");
      screen = e.view.render(100).join("\n");
      expect(screen).toContain("Send answers (starts or steers a turn)");
    } finally {
      e.view.dispose();
    }
  });

  it("renders form and current-question Markdown context in order", () => {
    const e = setup(false, false, {
      context: "**Shared constraints**",
      questions: [
        { ...question, context: "```ts\nconst local = 1;\n```" },
        { ...questionWithoutContext, id: "plain" },
      ],
    });

    try {
      Object.defineProperty(e.tui.terminal, "rows", {
        value: 80,
        configurable: true,
      });
      const screen = displayText(e.view.render(120).join("\n"));

      const positions = [
        "Shared constraints",
        "const local = 1;",
        question.question,
      ].map((text) => screen.indexOf(text));

      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toStrictEqual(positions.toSorted((a, b) => a - b));
      expect(screen).not.toContain("**Shared constraints**");
      expect(screen.split(question.question)).toHaveLength(2);
      e.press("l");
      const next = displayText(e.view.render(120).join("\n"));
      expect(next).toContain("Shared constraints");
      expect(next).not.toContain("const local");
    } finally {
      e.view.dispose();
    }
  });

  it("scrolls long context while keeping options and editors visible without changing answers", () => {
    const e = setup(true, false, {
      context: Array.from(
        { length: 40 },
        (_, i) => `Context line ${i} 日本語 👩🏽‍💻`
      ).join("\n\n"),
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
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "> [ ] 2. Second"
      );

      for (const [width, rows, shown] of [
        [40, 20, "> [ ] 2. Second"],
        [24, 14, "Terminal too small"],
        [12, 8, "Terminal too"],
        [100, 60, "> [ ] 2. Second"],
      ] as const) {
        Object.defineProperty(e.tui.terminal, "rows", {
          value: rows,
          configurable: true,
        });
        const lines = e.view.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(displayText(lines.join("\n"))).toContain(shown);
      }

      expect(e.mutations).toBe(0);
      e.press("n", "Visible note");
      expect(displayText(e.view.render(100).join("\n"))).toContain(
        "Visible note"
      );
      e.press("\u001B");
      expect(displayText(e.view.render(100).join("\n"))).toContain(
        "> [ ] 2. Second"
      );
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });

  it("scrolls context with normalized fullscreen wheel events and leaves pinned answers visible", () => {
    const e = setup(true, false, {
      context: Array.from({ length: 40 }, (_, i) => `Mouse context ${i}`).join(
        "\n\n"
      ),
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
        })
      ).toStrictEqual({ handled: true });
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
  ])(
    "pages directly between context endpoints at %i terminal rows",
    (rows, firstRange) => {
      const e = setup(false, false, {
        context: Array.from(
          { length: 15 },
          (_, i) => `Context entry ${i}`
        ).join("\n\n"),
        questions: [question],
      });

      try {
        Object.defineProperty(e.tui.terminal, "rows", {
          value: rows,
          configurable: true,
        });
        let screen = displayText(e.view.render(80).join("\n"));
        expect(screen).toContain(firstRange);
        expect(screen).toContain("Context entry 0");
        expect(screen).toContain("> ( ) 1. First");

        e.press(...Array.from({ length: 40 }, () => "pageDown"));
        screen = displayText(e.view.render(80).join("\n"));
        expect(screen).toContain(
          rows === 20 ? "Context 33–33 / 33" : "Context 29–33 / 33"
        );
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
    }
  );

  it("uses the resized context viewport when paging", () => {
    const e = setup(false, false, {
      context: Array.from({ length: 15 }, (_, i) => `Context entry ${i}`).join(
        "\n\n"
      ),
      questions: [question],
    });

    try {
      e.view.render(80);
      e.press("j", ...Array.from({ length: 40 }, () => "pageDown"));
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "Context 29–33 / 33"
      );

      Object.defineProperty(e.tui.terminal, "rows", {
        value: 18,
        configurable: true,
      });
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Context 29–29 / 33");
      expect(screen).toContain("Context entry 14");
      expect(screen).toContain("> ( ) 2. Second");

      e.press("pageDown", "pageDown", "pageDown", "pageDown");
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "Context 33–33 / 33"
      );
      e.press("pageUp", "pageUp");
      screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("Context 31–31 / 33");
      expect(screen).toContain("> ( ) 2. Second");
      expect(e.mutations).toBe(0);
    } finally {
      e.view.dispose();
    }
  });

  it.each([false, true])(
    "advertises configured scrolling keys (remapped: %s)",
    (remap) => {
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
        expect(e.view.render(80)).not.toStrictEqual(top);
        e.press(up);
        expect(e.view.render(80)).toStrictEqual(top);
        expect(e.mutations).toBe(0);
      } finally {
        e.view.dispose();
      }
    }
  );

  it.each(["\u001B", "\r", "h"])(
    "reveals the answer after closing a preview with %j",
    (close) => {
      const e = setup(true, false, {
        context: "Long context\n\n".repeat(40),
        questions: [{ ...question, multi_select: true }],
      });

      try {
        e.view.render(80);
        e.press("k");
        expect(displayText(e.view.render(80).join("\n"))).toContain(
          "> [ ] 1. First"
        );
        e.press("p");
        expect(displayText(e.view.render(80).join("\n"))).toContain(
          "const value"
        );
        e.press(close);
        expect(displayText(e.view.render(80).join("\n"))).toContain(
          "> [ ] 1. First"
        );
        expect(e.mutations).toBe(0);
        expect(e.done).not.toHaveBeenCalled();
      } finally {
        e.view.dispose();
      }
    }
  );

  it.each(["\u001B", "\r"])(
    "reveals the answer after leaving a note with %j",
    (close) => {
      const e = setup(true, false, {
        context: "Long context\n\n".repeat(40),
        questions: [{ ...question, multi_select: true }],
      });

      try {
        e.view.render(80);
        e.press("j");
        e.view.render(80);
        e.press("n", "Answer note");
        expect(displayText(e.view.render(80).join("\n"))).toContain(
          "Answer note"
        );
        e.press(close);
        expect(displayText(e.view.render(80).join("\n"))).toContain(
          "> [ ] 2. Second"
        );
        expect(e.item.draft?.["choice"]?.notes["second"]).toBe(
          close === "\r" ? "Answer note" : ""
        );
        expect(e.item.draft?.["choice"]?.selected).toStrictEqual([]);
        expect(e.done).not.toHaveBeenCalled();
      } finally {
        e.view.dispose();
      }
    }
  );

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
      Object.defineProperty(e.tui.terminal, "rows", {
        value: 40,
        configurable: true,
      });
      e.view.render(80);
      e.press("5");
      let screen = displayText(e.view.render(80).join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(screen).not.toContain("日本語 details");
      e.press("p");
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "日本語 details"
      );
      e.press("\u001B");
      Object.defineProperty(e.tui.terminal, "rows", {
        value: 20,
        configurable: true,
      });
      const lines = e.view.render(40);
      screen = displayText(lines.join("\n"));
      expect(screen).toContain("> [x] 5. Choice 4");
      expect(screen).not.toContain("Terminal too small");
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(e.item.draft?.["choice"]?.selected).toStrictEqual(["o4"]);
    } finally {
      e.view.dispose();
    }
  });

  it("uses j/k to highlight without selecting, but keeps editor text intact", () => {
    const e = setup();

    try {
      e.press("j");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 2. Second");
      e.press("k");
      expect(e.view.render(80).join("\n")).toContain("> ( ) 1. First");
      expect(e.mutations).toBe(0);
      e.press("j", "n", "jk", "\r", "\r", "\r");
      expect(e.outcome?.answers?.["choice"]?.selections).toStrictEqual([
        { option_id: "second", label: "Second", note: "jk" },
      ]);
      expect(
        intent(createKeybindings({ "tui.select.confirm": ["k"] }), "k")
      ).toBe("confirm");
    } finally {
      e.view.dispose();
    }
  });

  it("keeps highlight/context/preview view-only and requires Review then explicit submission", () => {
    const e = setup();

    try {
      e.press("p");
      expect(e.mutations).toBe(0);
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "const value"
      );
      e.press("\u001B", "\u001B[B", "p");
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "> ( ) 2. Second"
      );
      const before = e.view.render(80);
      e.press("c");
      expect(e.view.render(80)).toStrictEqual(before);
      expect(e.mutations).toBe(0);
      e.press("1");
      expect(e.done).not.toHaveBeenCalled();
      expect(e.view.render(80).join("\n")).toContain("Review");
      e.press("\r", "\r");
      expect(e.finish).toHaveBeenCalledExactlyOnceWith("submit");
      expect(e.item.draft).toBeUndefined();
    } finally {
      e.view.dispose();
    }
  });

  it("keeps an invalid submission editable until its required answers are supplied", () => {
    const e = setup();

    try {
      const before = structuredClone(e.item);
      e.press("r", "\r");
      expect(e.item).toStrictEqual(before);
      expect(e.view.render(80).join("\n")).toContain("Answer required: Choice");
      expect(e.done).not.toHaveBeenCalled();

      e.press("1", "1", "\r");
      expect(e.done).toHaveBeenCalledExactlyOnceWith(e.outcome);
      expect(e.outcome).toMatchObject({
        status: "answered",
        answers: { choice: { selections: [{ option_id: "first" }] } },
      });
    } finally {
      e.view.dispose();
    }
  });

  it("preserves distinct option notes across deselection", () => {
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
        "r",
        "\r"
      );
      expect(e.outcome?.answers?.["choice"]?.selections).toStrictEqual([
        { option_id: "second", label: "Second", note: "second note" },
        { option_id: "first", label: "First", note: "first note" },
      ]);
    } finally {
      e.view.dispose();
    }
  });

  it("uses remapped multiline completion, treats digits/paste as editor text, and never submits from an editor", () => {
    const e = setup(false, true);

    try {
      e.press(
        "\u001B[B",
        "\u001B[B",
        "\u001By",
        "123",
        "\u001Bj",
        "\u001B[200~r1s\u001B[201~",
        "\u001Bd"
      );
      expect(e.item.draft?.["choice"]?.custom).toBe("123\nr1s");
      expect(e.done).not.toHaveBeenCalled();
      e.press("r", "\u001By");
      expect(e.outcome?.answers?.["choice"]?.custom?.text).toBe("123\nr1s");
    } finally {
      e.view.dispose();
    }
  });

  it("reselects a saved custom answer without requiring a text change", () => {
    const e = setup();

    try {
      e.press(
        "\u001B[B",
        "\u001B[B",
        "\r",
        "Saved alternative",
        "\r",
        "1",
        "\u001B[D",
        "\u001B[B",
        "\u001B[B",
        "\r",
        "\r",
        "r",
        "\r"
      );
      expect(e.outcome?.answers?.["choice"]).toMatchObject({
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
        Object.defineProperty(e.tui.terminal, "rows", {
          value: rows,
          configurable: true,
        });
        const lines = e.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }

      e.press("\u001B", "n");
      e.view.handleInput("日".repeat(1001));
      expect(() => {
        e.view.flush();
      }).toThrow("limit");
      expect(e.item.draft?.["choice"]?.notes["first"]).toBe("");
      Object.defineProperty(e.tui.terminal, "rows", {
        value: 40,
        configurable: true,
      });
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      e.press("\r");
      expect(e.view.render(80).join("\n")).toContain("1001/1000");
      expect(e.view.render(80).join("\n")).toContain("limit");
      e.press("\u001B");
      expect(e.view.render(80).join("\n")).not.toContain("1001/1000");
      expect(e.item.draft?.["choice"]?.notes["first"]).toBe("");
    } finally {
      e.view.dispose();
    }
  });

  it("saves a written answer with Enter and advances, discards it with Escape", () => {
    const e = setup();

    try {
      e.press("\u001B[B", "\u001B[B", "\r", "typed then dropped", "\u001B");
      expect(e.item.draft?.["choice"]?.custom).toBe("");
      expect(e.item.draft?.["choice"]?.custom_selected).toBe(false);
      expect(e.view.render(80).join("\n")).toContain("Write answer");
      e.press("\r", "kept", "\r");
      expect(e.item.draft?.["choice"]).toMatchObject({
        custom: "kept",
        custom_selected: true,
      });
      expect(e.view.render(80).join("\n")).toContain("Send answers");
      e.press("1");
      expect(e.view.render(80).join("\n")).toContain(
        "> (•) Write another answer"
      );
      expect(e.view.render(80).join("\n")).toContain("Edit answer · → Next");
      e.press("\r", "\u001B");
      expect(e.item.draft?.["choice"]?.custom).toBe("kept");
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
      expect(e.item.draft?.["choice"]?.notes["second"]).toBe("inline note");
      expect(displayText(e.view.render(80).join("\n"))).toContain(
        "Note: inline note"
      );
    } finally {
      e.view.dispose();
    }
  });

  it.each([[[]], [["r"]]])(
    "dismisses with d after %j, without answering",
    (before) => {
      const e = setup();

      try {
        e.press("1", "\u001B[D", ...before, "d");
        expect(e.finish).toHaveBeenCalledExactlyOnceWith("dismiss");
        expect(e.done).toHaveBeenCalledExactlyOnceWith(e.outcome);
        expect(e.outcome).toStrictEqual({
          type: "questionnaire",
          interaction_id: "q_ui",
          status: "dismissed",
        });
        expect(e.item.draft).toBeUndefined();
      } finally {
        e.view.dispose();
      }
    }
  );

  it("opens on the first unanswered question with the current answer highlighted", () => {
    const e = setup(false, false, {
      questions: [
        { ...question, id: "first_q", multi_select: false },
        { ...question, id: "second_q", header: "Second question" },
      ],
    });

    try {
      e.press("2", "\u001B[D");
      expect(e.view.render(80).join("\n")).toContain("> (•) 2. Second");
    } finally {
      e.view.dispose();
    }
  });
});
