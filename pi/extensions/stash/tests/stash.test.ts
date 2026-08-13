import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";

const { copyToClipboard } = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyToClipboard,
}));

const { createStash } = await import("../stash.js");

const extension = (pi: ExtensionAPI) => {
  const stash = createStash();

  pi.on("session_start", (_event, ctx) => stash.start(ctx));
  pi.registerShortcut("ctrl+s", {
    handler: (ctx) => stash.toggle(ctx),
  });
  pi.registerCommand("pop-stash", {
    handler: (_args, ctx) => stash.pop(ctx),
  });
  pi.on("input", (event, ctx) => stash.prepareRestore(event, ctx));
  pi.on("turn_start", (_event, ctx) => stash.commitRestore(ctx));
  pi.on("session_shutdown", (_event, ctx) => stash.dispose(ctx));
};

const getStorePath = (agentDir: string, cwd: string) =>
  path.join(
    agentDir,
    "data",
    "stash",
    `${createHash("sha256").update(path.resolve(cwd)).digest("hex")}.json`
  );

describe("stash", () => {
  const envRestorers: (() => void)[] = [];
  let agentDir: string;

  const useAgentDir = async () => {
    const directory = await createTempDir("stash-agent-");
    envRestorers.push(patchEnv({ PI_CODING_AGENT_DIR: directory }));
    return directory;
  };

  const readStore = async (directory: string, cwd: string) =>
    JSON.parse(await readFile(getStorePath(directory, cwd), "utf-8")) as {
      entries: string[];
    };

  const createHarness = async (
    options: { cwd?: string; mode?: "json" | "rpc" | "tui" } = {}
  ) => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({
      cwd: options.cwd ?? process.cwd(),
      mode: options.mode ?? "tui",
    });
    await host.emitSessionStart(ctx);

    return {
      ctx,
      editorText() {
        return ctx.ui.getEditorText();
      },
      host,
      async input(text: string, source: "interactive" | "extension") {
        return await host.emitInput(
          {
            source,
            text,
            type: "input",
          },
          ctx
        );
      },
      notifications() {
        return host.getNotifications();
      },
      async popStash() {
        await host.runCommand("pop-stash", "", ctx);
      },
      async stash(text: string) {
        ctx.ui.setEditorText(text);
        await host.runShortcut("ctrl+s", ctx);
      },
    };
  };

  beforeEach(async () => {
    agentDir = await useAgentDir();
  });

  afterEach(() => {
    for (const restore of envRestorers.splice(0).toReversed()) {
      restore();
    }
    vi.restoreAllMocks();
    copyToClipboard.mockReset();
  });

  it("stashing clears the editor, defers copying, and emits a notification", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");

    expect(harness.editorText()).toBe("");
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(harness.notifications()).toContainEqual({
      message: "Stashed (1). Press c to copy to clipboard.",
      type: "info",
    });
  });

  it("persists stashed text across extension instances", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const first = await createHarness({ cwd });

    await first.stash("draft message");

    const second = await createHarness({ cwd });
    await second.popStash();

    expect(second.editorText()).toBe("draft message");
  });

  it("caps persisted and in-memory stashes to the ten newest entries", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const harness = await createHarness({ cwd });

    for (let index = 1; index <= 12; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- stash writes are intentionally sequential
      await harness.stash(`draft ${index}`);
    }

    expect(harness.notifications()).toContainEqual({
      message: "Stashed (10). Press c to copy to clipboard.",
      type: "info",
    });
    const store = await readStore(agentDir, cwd);
    expect(store.entries).toStrictEqual(
      Array.from({ length: 10 }, (_, index) => `draft ${index + 3}`)
    );

    const restored = await createHarness({ cwd });
    for (let index = 12; index >= 3; index -= 1) {
      // oxlint-disable-next-line no-await-in-loop -- each pop observes the previous mutation
      await restored.popStash();
      expect(restored.editorText()).toBe(`draft ${index}`);
    }

    await restored.popStash();
    expect(restored.notifications()).toContainEqual({
      message: "Nothing stashed.",
      type: "info",
    });
  });

  it("persists an empty cwd stack when the stack is emptied", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const harness = await createHarness({ cwd });

    await harness.stash("draft message");
    await harness.popStash();

    const store = await readStore(agentDir, cwd);
    expect(store).toStrictEqual({ entries: [] });
  });

  it("treats malformed persisted stash as empty", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const storePath = getStorePath(agentDir, cwd);
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, "{", "utf-8");
    const harness = await createHarness({ cwd });

    await harness.popStash();

    expect(harness.notifications()).toContainEqual({
      message: "Nothing stashed.",
      type: "info",
    });
  });

  it("keeps in-memory stash behavior when persistence fails", async () => {
    const invalidAgentDir = path.join(
      await createTempDir("stash-agent-parent-"),
      "file"
    );
    await writeFile(invalidAgentDir, "not a directory", "utf-8");
    envRestorers.push(patchEnv({ PI_CODING_AGENT_DIR: invalidAgentDir }));
    const harness = await createHarness({
      cwd: await createTempDir("stash-cwd-"),
    });

    await harness.stash("draft message");
    await harness.popStash();

    expect(harness.editorText()).toBe("draft message");
    expect(harness.notifications()).toContainEqual({
      message: "Failed to persist stash.",
      type: "warning",
    });
  });

  it("copies the stashed text and consumes input when c is pressed", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");
    const result = harness.host.terminalInput("c");

    expect(result.consumed).toBeTruthy();
    expect(copyToClipboard).toHaveBeenCalledWith("draft message");
    await vi.waitFor(() => {
      expect(harness.notifications()).toContainEqual({
        message: "Copied stash to clipboard.",
        type: "info",
      });
    });
  });

  it("cancels the pending copy and passes through other input", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");
    const cancelResult = harness.host.terminalInput("x");
    const lateCopyResult = harness.host.terminalInput("c");

    expect(cancelResult.consumed).toBeFalsy();
    expect(lateCopyResult.consumed).toBeFalsy();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("empty Ctrl+S cancels the pending copy while popping", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");
    await harness.host.runShortcut("ctrl+s", harness.ctx);
    const result = harness.host.terminalInput("c");

    expect(harness.editorText()).toBe("draft message");
    expect(result.consumed).toBeFalsy();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("does not cancel the pending copy on key repeat or release events", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");
    harness.host.terminalInput("\u001B[120;5:2u");
    harness.host.terminalInput("\u001B[120;5:3u");
    const copyResult = harness.host.terminalInput("c");

    expect(copyResult.consumed).toBeTruthy();
    expect(copyToClipboard).toHaveBeenCalledWith("draft message");
  });

  it("notifies when copying the stashed text fails", async () => {
    const harness = await createHarness();
    copyToClipboard.mockRejectedValueOnce(new Error("clipboard failed"));

    await harness.stash("draft message");
    const result = harness.host.terminalInput("c");

    expect(result.consumed).toBeTruthy();
    await vi.waitFor(() => {
      expect(harness.notifications()).toContainEqual({
        message: "Failed to copy stash to clipboard.",
        type: "warning",
      });
    });

    await harness.input("send message", "interactive");
    expect(harness.editorText()).toBe("draft message");
  });

  it("copies the most recent pending stash", async () => {
    const harness = await createHarness();

    await harness.stash("first");
    await harness.stash("second");
    const result = harness.host.terminalInput("c");

    expect(result.consumed).toBeTruthy();
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("second");
  });

  it("clears the pending copy on shutdown", async () => {
    const harness = await createHarness();

    await harness.stash("draft");
    await harness.host.emitSessionShutdown(harness.ctx);
    const result = harness.host.terminalInput("c");

    expect(result.consumed).toBeFalsy();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("restores the most recent stash on the next interactive input", async () => {
    const harness = await createHarness();

    await harness.stash("first draft");
    await harness.stash("second draft");
    await harness.input("send message", "interactive");

    expect(harness.editorText()).toBe("second draft");
  });

  it("does not restore on non-interactive input", async () => {
    const harness = await createHarness();

    await harness.stash("draft message");
    await harness.input("send message", "extension");

    expect(harness.editorText()).toBe("");
  });

  it("does not restore interactive input outside TUI mode", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const interactive = await createHarness({ cwd });
    await interactive.stash("draft message");

    const printMode = await createHarness({ cwd, mode: "json" });
    await printMode.input("send message", "interactive");

    expect(printMode.editorText()).toBe("");
    const store = await readStore(agentDir, cwd);
    expect(store.entries).toStrictEqual(["draft message"]);
  });

  it("waits for an in-flight save during shutdown", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const harness = await createHarness({ cwd });
    harness.ctx.ui.setEditorText("draft message");

    const saving = harness.host.runShortcut("ctrl+s", harness.ctx);
    await harness.host.emitSessionShutdown(harness.ctx);
    await saving;

    const store = await readStore(agentDir, cwd);
    expect(store.entries).toStrictEqual(["draft message"]);
  });

  it("does not stash blank editor text", async () => {
    const harness = await createHarness();

    await harness.stash("   \n\t  ");
    harness.ctx.ui.setEditorText("");
    await harness.input("send message", "interactive");

    expect(harness.editorText()).toBe("");
  });

  it("pops the most recent stash when Ctrl+S is pressed on an empty editor", async () => {
    const harness = await createHarness();

    await harness.stash("first");
    await harness.stash("second");

    harness.ctx.ui.setEditorText("");
    await harness.host.runShortcut("ctrl+s", harness.ctx);
    expect(harness.editorText()).toBe("second");

    harness.ctx.ui.setEditorText("");
    await harness.host.runShortcut("ctrl+s", harness.ctx);
    expect(harness.editorText()).toBe("first");
  });

  it("notifies when Ctrl+S is pressed on an empty editor with nothing stashed", async () => {
    const harness = await createHarness();

    harness.ctx.ui.setEditorText("");
    await harness.host.runShortcut("ctrl+s", harness.ctx);

    expect(harness.editorText()).toBe("");
    expect(harness.notifications()).toContainEqual({
      message: "Nothing stashed.",
      type: "info",
    });
  });

  it("persists stack changes when Ctrl+S pops on an empty editor", async () => {
    const cwd = await createTempDir("stash-cwd-");
    const harness = await createHarness({ cwd });

    await harness.stash("first");
    await harness.stash("second");

    harness.ctx.ui.setEditorText("");
    await harness.host.runShortcut("ctrl+s", harness.ctx);
    const afterFirstPop = await readStore(agentDir, cwd);
    expect(afterFirstPop.entries).toStrictEqual(["first"]);

    harness.ctx.ui.setEditorText("");
    await harness.host.runShortcut("ctrl+s", harness.ctx);
    const afterSecondPop = await readStore(agentDir, cwd);
    expect(afterSecondPop.entries).toStrictEqual([]);
  });

  it("pops stashed text in LIFO order across repeated /pop-stash calls", async () => {
    const harness = await createHarness();

    await harness.stash("first");
    await harness.stash("second");
    await harness.popStash();
    expect(harness.editorText()).toBe("second");

    harness.ctx.ui.setEditorText("cleared");
    await harness.popStash();

    expect(harness.editorText()).toBe("first");
  });

  it("notifies when /pop-stash is used with an empty stash", async () => {
    const harness = await createHarness();

    harness.ctx.ui.setEditorText("leave me alone");
    await harness.popStash();

    expect(harness.editorText()).toBe("leave me alone");
    expect(harness.notifications()).toContainEqual({
      message: "Nothing stashed.",
      type: "info",
    });
  });

  it("rejects /pop-stash outside the interactive UI", async () => {
    const harness = await createHarness();
    const ctx = harness.host.createContext({ hasUI: false });

    await expect(harness.host.runCommand("pop-stash", "", ctx)).rejects.toThrow(
      "pop-stash requires interactive UI"
    );
  });

  it("does not consume another stash entry after a manual pop clears a pending restore", async () => {
    const harness = await createHarness();
    const { ctx } = harness;

    await harness.stash("first");
    await harness.stash("second");
    await harness.input("send message", "interactive");
    expect(harness.editorText()).toBe("second");

    harness.ctx.ui.setEditorText("");
    await harness.popStash();
    expect(harness.editorText()).toBe("second");

    await harness.host.emit(
      "turn_start",
      { turnIndex: 0, type: "turn_start" },
      ctx
    );

    harness.ctx.ui.setEditorText("");
    await harness.popStash();
    expect(harness.editorText()).toBe("first");
  });

  it("preserves the stash when input is handled and turn_start never fires", async () => {
    const harness = await createHarness();

    await harness.stash("saved draft");

    await harness.input("handled message", "interactive");

    expect(harness.editorText()).toBe("saved draft");

    harness.ctx.ui.setEditorText("");
    await harness.input("next attempt", "interactive");
    expect(harness.editorText()).toBe("saved draft");
  });

  it("only consumes the stash once even across multiple turn_start events", async () => {
    const harness = await createHarness();
    const { ctx } = harness;

    await harness.stash("single draft");
    await harness.input("go", "interactive");

    await harness.host.emit(
      "turn_start",
      { turnIndex: 0, type: "turn_start" },
      ctx
    );

    await harness.host.emit(
      "turn_start",
      { turnIndex: 1, type: "turn_start" },
      ctx
    );

    harness.ctx.ui.setEditorText("");
    await harness.popStash();
    expect(harness.notifications()).toContainEqual({
      message: "Nothing stashed.",
      type: "info",
    });
  });
});
