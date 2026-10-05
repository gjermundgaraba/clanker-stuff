import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import extension from "../index.js";
import { loadHistory, openHistoryDatabase, saveHistoryBatch } from "../storage.js";
import { createEditor, nonPromptEntries, search, userEntry } from "./fixtures.js";

const ESCAPE = "\u001B";

const shutdowns: (() => Promise<void>)[] = [];

const sessionFile = (id: string, ...lines: unknown[]) =>
  [
    JSON.stringify({
      cwd: "/project",
      id: `${id}-session`,
      timestamp: new Date(50).toISOString(),
      type: "session",
      version: 3,
    }),
    ...lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))),
  ].join("\n");

const createHarness = async (sessionDirectory?: string) => {
  const host = createExtensionHost(extension);
  const ctx = host.createContext();

  const directory =
    sessionDirectory ?? path.join(process.env.PI_CODING_AGENT_DIR ?? "", "sessions", "test");

  Object.assign(ctx.sessionManager, { getSessionDir: () => directory });
  await host.emitSessionStart(ctx);
  shutdowns.push(() => host.emitSessionShutdown(ctx));

  const prompt = (text: string, source: "interactive" | "extension" | "rpc" = "interactive") =>
    host.emitInput({ source, text, type: "input" }, ctx);

  return { ctx, host, prompt };
};

describe("history runtime", () => {
  let agentDir = "";
  let restoreAgentDir: (() => void) | undefined;

  beforeEach(async () => {
    agentDir = await createTempDir("history-");
    restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
  });

  afterEach(async () => {
    await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
    vi.restoreAllMocks();
    restoreAgentDir?.();
    await rm(agentDir, { force: true, recursive: true });
  });

  it("seeds native recall with the latest global prompts, also in resumed sessions", async () => {
    const first = await createHarness();
    await first.prompt("from another session");
    await first.host.emitSessionShutdown(first.ctx);

    const host = createExtensionHost(extension, {
      entries: [userEntry("current", null, "resumed session prompt", 100)],
      leafId: "current",
    });

    const ctx = host.createContext();
    Object.assign(ctx.sessionManager, { getSessionDir: () => path.join(agentDir, "sessions") });
    await host.emitSessionStart(ctx, "resume");
    shutdowns.push(() => host.emitSessionShutdown(ctx));
    expect([...host.getRegisteredCommands().keys()]).toEqual(["history-import"]);

    const editor = createEditor(host);
    editor.handleInput("\u001B[A");
    expect(editor.getText()).toBe("from another session");
  });

  it("accepts interactive prompts and bash commands into the draft without submitting", async () => {
    const { ctx, host, prompt } = await createHarness();
    await prompt("new local prompt");
    await prompt("extension prompt", "extension");
    await prompt("rpc prompt", "rpc");
    await host.emit(
      "user_bash",
      { command: "pnpm test", cwd: ctx.cwd, excludeFromContext: true, type: "user_bash" },
      ctx,
    );

    ctx.ui.setEditorText("unsent draft");
    expect(await search(host, ["extension", ESCAPE])).toContain("no match");
    expect(await search(host, ["rpc", ESCAPE])).toContain("no match");
    expect(ctx.ui.getEditorText()).toBe("unsent draft");

    await search(host, ["local", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("new local prompt");
    await search(host, ["pnpm", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("!!pnpm test");
  });

  it("closes an open search on shutdown without touching the draft", async () => {
    const { ctx, host, prompt } = await createHarness();
    await prompt("saved prompt");
    ctx.ui.setEditorText("unsent draft");

    await search(host, ["saved"], () => host.emitSessionShutdown(ctx));
    expect(ctx.ui.getEditorText()).toBe("unsent draft");
  });

  it.each(["print", "json", "rpc"] as const)("does nothing in %s mode", async (mode) => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ mode });
    await host.emitSessionStart(ctx);
    await host.emitInput({ source: "interactive", text: "automated", type: "input" }, ctx);
    await host.runShortcut("ctrl+r", ctx);
    await host.runCommand("history-import", "", ctx);
    await host.emitSessionShutdown(ctx);
    expect(host.getEditorFactory()).toBeUndefined();
    expect(host.getNotifications()).toEqual([]);
    await expect(access(path.join(agentDir, "data"))).rejects.toThrow();
  });

  it("keeps --no-session history in memory without touching the store", async () => {
    const { ctx, host, prompt } = await createHarness("");
    await prompt("private prompt");

    await search(host, ["private", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("private prompt");
    await expect(access(path.join(agentDir, "data"))).rejects.toThrow();
  });

  it("falls back to in-memory history when the store cannot open", async () => {
    process.env.PI_CODING_AGENT_DIR = path.join(agentDir, "not-a-directory");
    await writeFile(process.env.PI_CODING_AGENT_DIR, "blocked", "utf-8");
    const { ctx, host, prompt } = await createHarness();
    await prompt("current prompt");

    await search(host, ["current", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("current prompt");
    await host.runCommand("history-import", "", ctx);
    expect(host.getNotifications().map(({ type }) => type)).toEqual(["warning", "warning"]);
  });

  it("deduplicates repeated prompts and moves them to the front", async () => {
    const { ctx, host, prompt } = await createHarness();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300);
    await prompt("duplicate alpha");
    await prompt("other alpha");
    await prompt("duplicate alpha");

    await search(host, ["alpha", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("duplicate alpha");
    await search(host, ["alpha", "\u0012", "\u0012", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("other alpha");
  });

  it("reloads only after another process writes", async () => {
    const first = await createHarness();
    const second = await createHarness();
    await search(second.host, [ESCAPE]);
    const loads = vi.spyOn(StatementSync.prototype, "all");

    await second.prompt("local prompt");
    await search(second.host, ["local", "\r"]);
    expect(loads).not.toHaveBeenCalled();

    await first.prompt("external prompt");
    await search(second.host, ["external", "\r"]);
    expect(second.ctx.ui.getEditorText()).toBe("external prompt");
    expect(loads).toHaveBeenCalledOnce();
  });

  it("imports prompts and bash commands without modifying session files", async () => {
    const sessionPath = path.join(agentDir, "sessions", "project", "legacy.jsonl");
    await mkdir(path.dirname(sessionPath), { recursive: true });

    const original = sessionFile(
      "legacy",
      userEntry("old", null, "legacy prompt", 100),
      "{not json",
      {
        id: "bash",
        message: {
          command: "pnpm test",
          excludeFromContext: true,
          role: "bashExecution",
          timestamp: 300,
        },
        parentId: "old",
        timestamp: new Date(300).toISOString(),
        type: "message",
      },
      ...nonPromptEntries("bash", 400),
    );

    await writeFile(sessionPath, original, "utf-8");
    const { ctx, host } = await createHarness();
    await search(host, [ESCAPE]);
    await host.runCommand("history-import", "", ctx);

    await search(host, ["legacy", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("legacy prompt");
    await search(host, ["pnpm", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("!!pnpm test");
    expect(await search(host, ["non-prompt", ESCAPE])).toContain("no match");
    expect(host.getNotifications()).toContainEqual({
      message: "Imported prompt history from 1 session files.",
      type: "info",
    });
    await expect(readFile(sessionPath, "utf-8")).resolves.toBe(original);
  });

  it("imports the current custom session directory", async () => {
    const custom = path.join(agentDir, "custom");
    await mkdir(custom, { recursive: true });
    await writeFile(
      path.join(custom, "session.jsonl"),
      sessionFile("custom", userEntry("custom", null, "custom directory prompt", 100)),
    );

    const { ctx, host } = await createHarness(custom);
    await host.runCommand("history-import", "", ctx);
    await search(host, ["custom directory", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("custom directory prompt");
  });

  it("keeps files committed before a later import failure searchable", async () => {
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "a.jsonl"),
      sessionFile("a", userEntry("a", null, "committed before failure", 300)),
    );
    await writeFile(
      path.join(directory, "z.jsonl"),
      sessionFile("z", userEntry("z", null, "blocked after commit", 200)),
    );
    const { ctx, host } = await createHarness();
    await search(host, [ESCAPE]);

    const blocker = openHistoryDatabase();
    blocker.exec(`CREATE TRIGGER block_import BEFORE INSERT ON history
      WHEN NEW.text = 'blocked after commit' BEGIN SELECT RAISE(FAIL, 'blocked write'); END;`);
    blocker.close();
    await host.runCommand("history-import", "", ctx);

    expect(host.getNotifications()).toContainEqual({
      message: "Session history import failed: blocked write",
      type: "error",
    });
    await search(host, ["committed", "\r"]);
    expect(ctx.ui.getEditorText()).toBe("committed before failure");
  });

  it("searches newest first and selects older matches", async () => {
    const writer = openHistoryDatabase();
    saveHistoryBatch(writer, [
      { text: "alpha older", timestamp: 100 },
      { text: "alpha newer", timestamp: 200 },
    ]);
    expect(loadHistory(writer, 1)).toEqual([{ text: "alpha newer", timestamp: 200 }]);
    writer.close();

    const { ctx, host } = await createHarness();
    expect(await search(host, ["alpha", "\u001B[A", "\r"])).toContain("2/2");
    expect(ctx.ui.getEditorText()).toBe("alpha older");
  });
});
