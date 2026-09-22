import { acquireEditorHost, EditorHost } from "@clanker-stuff/editor";
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

describe("history editor", () => {
  it.each(["startup", "new", "reload"] as const)(
    "seeds an empty %s session from global history, oldest first",
    (reason) => {
      const { ctx } = setup();
      const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
      installHistoryEditor(start(reason), ctx, () => persisted);
      expect(seedHistory).toHaveBeenCalledExactlyOnceWith(["older global", "latest global"]);
    },
  );

  it("passes exactly the latest 100 prompts to the editor host, oldest first", () => {
    const { ctx } = setup();
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");

    const history = Array.from({ length: 105 }, (_, index) => ({
      text: `prompt ${105 - index}`,
      timestamp: 105 - index,
    }));

    installHistoryEditor(start("startup"), ctx, () => history);
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: 100 }, (_, index) => `prompt ${index + 6}`),
    );
  });

  it("does not double-seed Pi's initial resumed-session replay", () => {
    const { ctx } = setup(branch);
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
    installHistoryEditor(start("startup"), ctx, () => persisted);
    // Initial InteractiveMode startup replays user messages after session_start.
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith([]);
  });

  it.each(["resume", "fork", "reload", "new"] as const)(
    "seeds only the active branch for a populated %s session",
    (reason) => {
      const { host, ctx } = setup([...branch, userEntry("other", "a", "other branch", 400)]);
      host.setLeafId("b");
      const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
      installHistoryEditor(start(reason), ctx, () => persisted);
      expect(seedHistory).toHaveBeenCalledExactlyOnceWith(["older session", "latest session"]);
    },
  );

  it.each(["resume", "fork"] as const)("does not treat an empty %s as fresh", (reason) => {
    const { ctx } = setup();
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
    installHistoryEditor(start(reason), ctx, () => persisted);
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("does not treat a CLI fork as fresh", () => {
    const { ctx } = setup();
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
    Object.assign(ctx.sessionManager, {
      getHeader: () => ({ parentSession: "/parent.jsonl" }),
    });
    installHistoryEditor(start("startup"), ctx, () => persisted);
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("does not treat a rewound conversation as fresh", () => {
    const { host, ctx } = setup(branch);
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
    host.setLeafId(null);
    installHistoryEditor(start("reload"), ctx, () => persisted);
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("never seeds global data into an ephemeral session", () => {
    const { ctx } = setup();
    const seedHistory = vi.spyOn(EditorHost.prototype, "seedHistory");
    Object.assign(ctx.sessionManager, { getSessionDir: () => "" });
    installHistoryEditor(start("startup"), ctx, () => persisted);
    expect(seedHistory).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("wires seeded recall through the shared native editor with embedded status", () => {
    const { host, ctx } = setup();
    installHistoryEditor(start("startup"), ctx, () => persisted);
    const editor = createEditor(host);
    expect(acquireEditorHost(ctx)?.editor).toBe(editor);
    expect(editor).toBeInstanceOf(CustomEditor);

    if (editor instanceof CustomEditor) expect(editor.embedWorkingStatus).toBe(true);
    expect(editor.getText()).toBe("");
    editor.handleInput(up);
    editor.render(80);
    expect(editor.getText()).toBe("latest global");
    editor.handleInput(up);
    editor.render(80);
    expect(editor.getText()).toBe("older global");
  });

  it("skips recall attachment without replacing a competing editor", () => {
    const { ctx } = setup();
    const previous = new CustomEditor(createMockTui(), editorTheme, createKeybindings());
    const factory = () => previous;
    ctx.ui.setEditorComponent(factory);
    installHistoryEditor(start("startup"), ctx, () => persisted);
    expect(ctx.ui.getEditorComponent()).toBe(factory);
  });
});
