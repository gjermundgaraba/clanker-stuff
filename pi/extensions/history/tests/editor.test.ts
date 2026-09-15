import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createKeybindings, createMockTui } from "../../../tests/harness/tui.js";
import { installHistoryEditor } from "../editor.js";
import { createEditor, editorTheme, userEntry } from "./fixtures.js";

const persisted = [
  { text: "latest global", timestamp: 300 },
  { text: "older global", timestamp: 100 },
];
const branch = [
  userEntry("a", null, "older session", 50),
  userEntry("b", "a", "latest session", 200),
];

const setup = (entries: SessionEntry[] = []) => {
  const host = createExtensionHost(() => {}, { entries, leafId: entries.at(-1)?.id ?? null });
  const ctx = host.createContext();
  Object.assign(ctx.sessionManager, {
    getHeader: () => undefined,
    getSessionDir: () => "/sessions",
  });
  return { host, ctx };
};

const start = (reason: SessionStartEvent["reason"]): SessionStartEvent => ({
  reason,
  type: "session_start",
});

const up = "\u001B[A";
const down = "\u001B[B";

const recall = (editor: ReturnType<typeof createEditor>, key: string) => {
  editor.handleInput(key);
  editor.render(80);
  return editor.getText();
};

describe("history editor", () => {
  it.each(["startup", "new", "reload"] as const)(
    "seeds an empty %s session newest-first without changing its draft",
    (reason) => {
      const { host, ctx } = setup();
      installHistoryEditor(start(reason), ctx, () => persisted);
      const editor = createEditor(host);
      expect(editor.getText()).toBe("");
      expect(recall(editor, up)).toBe("latest global");
      expect(recall(editor, up)).toBe("older global");
      expect(recall(editor, up)).toBe("older global");
      expect(recall(editor, down)).toBe("latest global");
      expect(recall(editor, down)).toBe("");

      editor.setText("unfinished draft");
      expect(recall(editor, up)).toBe("unfinished draft"); // Move to the start first.
      expect(recall(editor, up)).toBe("latest global");
      expect(recall(editor, down)).toBe("unfinished draft");
      expect(editor).toBeInstanceOf(CustomEditor);
      if (editor instanceof CustomEditor) expect(editor.embedWorkingStatus).toBeTruthy();
    },
  );

  it("keeps only the latest 100 prompts and lets new submissions join native history", () => {
    const { host, ctx } = setup();
    const history = Array.from({ length: 105 }, (_, index) => ({
      text: `prompt ${105 - index}`,
      timestamp: 105 - index,
    }));
    installHistoryEditor(start("startup"), ctx, () => history);
    const editor = createEditor(host);
    for (let index = 0; index < 105; index++) recall(editor, up);
    expect(editor.getText()).toBe("prompt 6");
    editor.setText("");
    editor.addToHistory?.("just submitted");
    expect(recall(editor, up)).toBe("just submitted");
  });

  it("leaves multiline cursor movement to the underlying editor", () => {
    const { host, ctx } = setup();
    installHistoryEditor(start("startup"), ctx, () => persisted);
    const editor = createEditor(host);
    editor.setText("first\nsecond");
    expect(recall(editor, up)).toBe("first\nsecond");
    expect(recall(editor, up)).toBe("first\nsecond");
    expect(recall(editor, up)).toBe("latest global");
    expect(recall(editor, down)).toBe("first\nsecond");
  });

  it("does not steal arrows from an autocomplete menu", async () => {
    const { host, ctx } = setup();
    installHistoryEditor(start("startup"), ctx, () => persisted);
    const editor = createEditor(host);
    if (!(editor instanceof CustomEditor)) throw new Error("Expected CustomEditor");
    editor.setAutocompleteProvider({
      getSuggestions: () =>
        Promise.resolve({
          prefix: "",
          items: [
            { value: "choice one", label: "choice one" },
            { value: "choice two", label: "choice two" },
          ],
        }),
      applyCompletion: (_lines, _line, _col, item) => ({
        lines: [item.value],
        cursorLine: 0,
        cursorCol: item.value.length,
      }),
    });
    editor.handleInput("\t");
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBeTruthy());
    expect(recall(editor, down)).toBe("");
    expect(recall(editor, up)).toBe("");
    expect(recall(editor, "\r")).toBe("choice one");
  });

  it("does not double-seed Pi's initial resumed-session replay", () => {
    const { host, ctx } = setup(branch);
    installHistoryEditor(start("startup"), ctx, () => persisted);
    const editor = createEditor(host);
    expect(recall(editor, up)).toBe("");
    // Initial InteractiveMode startup replays user messages after session_start.
    editor.addToHistory?.("older session");
    editor.addToHistory?.("latest session");
    expect(recall(editor, up)).toBe("latest session");
    expect(recall(editor, up)).toBe("older session");
    expect(recall(editor, up)).toBe("older session");
  });

  it.each(["resume", "fork", "reload", "new"] as const)(
    "seeds only the active branch for a populated %s session",
    (reason) => {
      const { host, ctx } = setup(branch);
      installHistoryEditor(start(reason), ctx, () => persisted);
      const editor = createEditor(host);
      expect(recall(editor, up)).toBe("latest session");
      expect(recall(editor, up)).toBe("older session");
      expect(recall(editor, up)).toBe("older session");
    },
  );

  it.each(["resume", "fork"] as const)("does not treat an empty %s as fresh", (reason) => {
    const { host, ctx } = setup();
    installHistoryEditor(start(reason), ctx, () => persisted);
    expect(recall(createEditor(host), up)).toBe("");
  });

  it("does not treat a CLI fork or a rewound conversation as fresh", () => {
    const fork = setup();
    Object.assign(fork.ctx.sessionManager, {
      getHeader: () => ({ parentSession: "/parent.jsonl" }),
    });
    installHistoryEditor(start("startup"), fork.ctx, () => persisted);
    expect(recall(createEditor(fork.host), up)).toBe("");

    const rewind = setup(branch);
    rewind.host.setLeafId(null);
    installHistoryEditor(start("reload"), rewind.ctx, () => persisted);
    expect(recall(createEditor(rewind.host), up)).toBe("");
  });

  it("never seeds global data into an ephemeral session", () => {
    const { host, ctx } = setup();
    Object.assign(ctx.sessionManager, { getSessionDir: () => "" });
    installHistoryEditor(start("startup"), ctx, () => persisted);
    expect(recall(createEditor(host), up)).toBe("");
  });

  it("composes with an earlier editor factory and can be composed by a later one", () => {
    const { host, ctx } = setup();
    const previous = new CustomEditor(createMockTui(), editorTheme, createKeybindings());
    const handleInput = vi.spyOn(previous, "handleInput");
    ctx.ui.setEditorComponent(() => previous);
    installHistoryEditor(start("startup"), ctx, () => persisted);
    const historyFactory = ctx.ui.getEditorComponent();
    if (!historyFactory) throw new Error("Expected factory");
    ctx.ui.setEditorComponent((tui, theme, keys) => historyFactory(tui, theme, keys));
    const editor = createEditor(host);
    expect(editor).toBe(previous);
    expect(recall(editor, up)).toBe("latest global");
    expect(handleInput).toHaveBeenCalledWith(up);
  });

  it("keeps an editor without optional history support usable", () => {
    const { host, ctx } = setup();
    const previous = {
      getText: () => "draft",
      handleInput: vi.fn<(data: string) => void>(),
      invalidate() {},
      render: () => ["draft"],
      setText: vi.fn<(text: string) => void>(),
    };
    ctx.ui.setEditorComponent(() => previous);
    installHistoryEditor(start("startup"), ctx, () => persisted);
    expect(createEditor(host)).toBe(previous);
  });
});
