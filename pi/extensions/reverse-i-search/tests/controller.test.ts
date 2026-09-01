import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import { createReverseSearch } from "../controller.js";
import { loadHistory, openHistoryDatabase } from "../history.js";
import { nonPromptEntries, userEntry } from "./fixtures.js";

const shutdowns: (() => Promise<void>)[] = [];

const extension = (pi: ExtensionAPI) => {
  const search = createReverseSearch();

  pi.registerShortcut("ctrl+r", {
    handler: (ctx) => search.open(ctx),
  });
  pi.registerCommand("reverse-i-search-import", {
    handler: (_args, ctx) => search.importHistory(ctx),
  });
  pi.on("session_start", (_event, ctx) => search.start(ctx));
  pi.on("input", (event, ctx) => search.recordInput(event, ctx));
  pi.on("user_bash", (event, ctx) => search.recordBash(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => search.dispose(ctx));
};

const persistentSessionFile = (id: string, text: string, timestamp: number) =>
  [
    JSON.stringify({
      cwd: "/project",
      id: `${id}-session`,
      timestamp: new Date(50).toISOString(),
      type: "session",
      version: 3,
    }),
    JSON.stringify(userEntry(id, null, text, timestamp)),
  ].join("\n");

const createHarness = async (
  entries: SessionEntry[] = [],
  sessionDirectory = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "sessions", "test"),
) => {
  const host = createExtensionHost(extension, {
    entries,
    leafId: entries.at(-1)?.id ?? null,
  });
  const ctx = host.createContext();
  Object.assign(ctx.sessionManager, {
    getSessionDir: () => sessionDirectory,
  });
  await host.emitSessionStart(ctx);
  shutdowns.push(() => host.emitSessionShutdown(ctx));
  return { ctx, host };
};

describe("reverse-search controller", () => {
  let agentDir = "";
  let restoreAgentDir: (() => void) | undefined;

  beforeEach(async () => {
    agentDir = await createTempDir("reverse-i-search-");
    restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
  });

  afterEach(async () => {
    await Promise.all(shutdowns.splice(0).map((shutdown) => shutdown()));
    vi.restoreAllMocks();
    restoreAgentDir?.();
    await rm(agentDir, { force: true, recursive: true });
  });

  it("adds interactive prompts and bash commands but ignores extension input", async () => {
    const { ctx, host } = await createHarness();

    await host.emitInput({ source: "interactive", text: "new local prompt", type: "input" }, ctx);
    await host.emitInput({ source: "extension", text: "extension prompt", type: "input" }, ctx);
    await host.emit(
      "user_bash",
      {
        command: "pnpm test",
        cwd: process.cwd(),
        excludeFromContext: true,
        type: "user_bash",
      },
      ctx,
    );

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("local");
    expect(ctx.ui.getEditorText()).toBe("new local prompt");

    host.terminalInput("\u0015");
    host.terminalInput("extension");
    expect(ctx.ui.getEditorText()).toBe("");

    host.terminalInput("\u001B");
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("pnpm");
    expect(ctx.ui.getEditorText()).toBe("!!pnpm test");
  });

  it("keeps no-session history in memory only", async () => {
    const { ctx, host } = await createHarness();
    Object.assign(ctx.sessionManager, { getSessionDir: () => "" });
    await host.emitSessionShutdown(ctx);
    await host.emitSessionStart(ctx);

    await host.emitInput({ source: "interactive", text: "ephemeral prompt", type: "input" }, ctx);
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("ephemeral");

    expect(ctx.ui.getEditorText()).toBe("ephemeral prompt");
    const database = openHistoryDatabase();
    expect(loadHistory(database)).not.toContainEqual(
      expect.objectContaining({ text: "ephemeral prompt" }),
    );
    database.close();
  });

  it("deduplicates repeated prompts and moves them to the front", async () => {
    const { ctx, host } = await createHarness();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300);

    await host.emitInput({ source: "interactive", text: "duplicate alpha", type: "input" }, ctx);
    await host.emitInput({ source: "interactive", text: "other alpha", type: "input" }, ctx);
    await host.emitInput({ source: "interactive", text: "duplicate alpha", type: "input" }, ctx);

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("alpha");
    expect(ctx.ui.getEditorText()).toBe("duplicate alpha");
    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("other alpha");
    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("other alpha");
  });

  it("searches content near the end of a long prompt persisted by another session", async () => {
    const prompt = `archived-${"x".repeat(4096)}-tail-marker`;
    const first = await createHarness();
    await first.host.emitInput({ source: "interactive", text: prompt, type: "input" }, first.ctx);
    await first.host.emitSessionShutdown(first.ctx);

    const second = await createHarness();
    await second.host.runShortcut("ctrl+r", second.ctx);
    second.host.terminalInput("tail-marker");

    expect(second.ctx.ui.getEditorText()).toBe(prompt);
  });

  it("does not mask an external write when recording local history", async () => {
    const first = await createHarness();
    const second = await createHarness();

    await second.host.runShortcut("ctrl+r", second.ctx);
    second.host.terminalInput("\u001B");
    await first.host.emitInput(
      { source: "interactive", text: "external before local", type: "input" },
      first.ctx,
    );
    await second.host.emitInput(
      { source: "interactive", text: "second local prompt", type: "input" },
      second.ctx,
    );

    await second.host.runShortcut("ctrl+r", second.ctx);
    second.host.terminalInput("external before local");
    expect(second.ctx.ui.getEditorText()).toBe("external before local");
  });

  it("imports only prompts and bash commands while skipping malformed lines", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", "project");
    const sessionPath = path.join(sessionDirectory, "legacy.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    const original = [
      JSON.stringify({
        cwd: "/project",
        id: "session",
        timestamp: new Date(50).toISOString(),
        type: "session",
        version: 3,
      }),
      JSON.stringify(userEntry("old", null, "legacy prompt", 100)),
      "{not json",
      JSON.stringify(userEntry("new", "old", "legacy prompt", 200)),
      JSON.stringify({
        id: "bash",
        message: {
          command: "pnpm test",
          excludeFromContext: true,
          role: "bashExecution",
          timestamp: 300,
        },
        parentId: "new",
        timestamp: new Date(300).toISOString(),
        type: "message",
      }),
      ...nonPromptEntries("bash", 400).map((entry) => JSON.stringify(entry)),
    ].join("\n");
    await writeFile(sessionPath, original, "utf-8");

    const { ctx, host } = await createHarness();
    await host.runCommand("reverse-i-search-import", "", ctx);

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("legacy");
    expect(ctx.ui.getEditorText()).toBe("legacy prompt");
    host.terminalInput("\u001B");

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("pnpm");
    expect(ctx.ui.getEditorText()).toBe("!!pnpm test");
    host.terminalInput("\u0015");
    host.terminalInput("non-prompt");
    expect(ctx.ui.getEditorText()).toBe("");

    await host.runCommand("reverse-i-search-import", "", ctx);
    expect(
      host.getNotifications().filter(({ message }) => message.startsWith("Imported 2 history")),
    ).toHaveLength(2);
    await expect(readFile(sessionPath, "utf-8")).resolves.toBe(original);
  });

  it("imports newly selected custom session directories", async () => {
    const firstDirectory = path.join(agentDir, "custom-a");
    const secondDirectory = path.join(agentDir, "custom-b");
    await Promise.all(
      [
        [firstDirectory, "first.jsonl", "prompt from directory a"],
        [secondDirectory, "second.jsonl", "prompt from directory b"],
      ].map(async ([directory, file, text], index) => {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, file),
          [
            JSON.stringify({
              cwd: `/project-${index}`,
              id: `session-${index}`,
              timestamp: new Date(50).toISOString(),
              type: "session",
              version: 3,
            }),
            JSON.stringify(userEntry(`entry-${index}`, null, text, 100 + index)),
          ].join("\n"),
          "utf-8",
        );
      }),
    );

    const first = await createHarness([], firstDirectory);
    await first.host.runCommand("reverse-i-search-import", "", first.ctx);
    await first.host.emitSessionShutdown(first.ctx);

    const second = await createHarness([], secondDirectory);
    await second.host.runCommand("reverse-i-search-import", "", second.ctx);
    await second.host.runShortcut("ctrl+r", second.ctx);
    second.host.terminalInput("directory a");
    expect(second.ctx.ui.getEditorText()).toBe("prompt from directory a");
    second.host.terminalInput("\u0015");
    second.host.terminalInput("directory b");
    expect(second.ctx.ui.getEditorText()).toBe("prompt from directory b");
  });

  it("reports database write failures during import", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", "project");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      path.join(sessionDirectory, "blocked.jsonl"),
      [
        JSON.stringify({
          cwd: "/project",
          id: "blocked-session",
          timestamp: new Date(50).toISOString(),
          type: "session",
          version: 3,
        }),
        JSON.stringify(userEntry("blocked", null, "blocked prompt", 100)),
      ].join("\n"),
      "utf-8",
    );

    const { ctx, host } = await createHarness();
    const blocker = openHistoryDatabase();
    blocker.exec(`
      CREATE TRIGGER block_history_import
      BEFORE INSERT ON history
      BEGIN
        SELECT RAISE(FAIL, 'blocked import write');
      END;
    `);
    blocker.close();

    await host.runCommand("reverse-i-search-import", "", ctx);
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("Session history import failed: blocked import write"),
      type: "error",
    });
  });

  it("reconciles files committed before a later import failure", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", "project");
    const committedPath = path.join(sessionDirectory, "committed.jsonl");
    const blockedPath = path.join(sessionDirectory, "blocked.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        committedPath,
        persistentSessionFile("committed", "committed before failure", 300),
        "utf-8",
      ),
      writeFile(
        blockedPath,
        persistentSessionFile("blocked", "blocked after commit", 200),
        "utf-8",
      ),
    ]);
    const { ctx, host } = await createHarness();
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("\u001B");

    const blocker = openHistoryDatabase();
    blocker.exec(`
      CREATE TRIGGER block_later_history_import
      BEFORE INSERT ON history
      WHEN NEW.text = 'blocked after commit'
      BEGIN
        SELECT RAISE(FAIL, 'blocked later import write');
      END;
    `);
    blocker.close();

    await host.runCommand("reverse-i-search-import", "", ctx);
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("Session history import failed: blocked later import write"),
      type: "error",
    });

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("committed before");
    expect(ctx.ui.getEditorText()).toBe("committed before failure");
  });

  it("reloads a concurrent write committed while history is loading", async () => {
    const { ctx, host } = await createHarness();
    const writer = openHistoryDatabase();
    let injectedWrite = false;
    let allSpy = vi.spyOn(StatementSync.prototype, "all");
    const allWithConcurrentWrite = function allWithConcurrentWrite(this: StatementSync) {
      allSpy.mockRestore();
      const rows = this.all();
      if (!injectedWrite && this.sourceSQL.includes("SELECT text, last_used_at")) {
        injectedWrite = true;
        writer
          .prepare("INSERT INTO history (text, last_used_at) VALUES (?, ?)")
          .run("concurrent snapshot prompt", 100);
      }
      allSpy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(allWithConcurrentWrite);
      return rows;
    };
    allSpy.mockImplementation(allWithConcurrentWrite);

    await host.runCommand("reverse-i-search-import", "", ctx);
    allSpy.mockRestore();
    writer.close();

    expect(injectedWrite).toBeTruthy();
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("snapshot");
    expect(ctx.ui.getEditorText()).toBe("concurrent snapshot prompt");
  });

  it("falls back to current-session history when SQLite cannot open", async () => {
    const invalidAgentDir = path.join(agentDir, "not-a-directory");
    await writeFile(invalidAgentDir, "blocked", "utf-8");
    process.env.PI_CODING_AGENT_DIR = invalidAgentDir;

    const { ctx, host } = await createHarness([userEntry("current", null, "current prompt", 100)]);
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("current");

    expect(ctx.ui.getEditorText()).toBe("current prompt");
    expect(host.getNotifications()).toContainEqual({
      message: expect.stringContaining("Prompt history persistence is unavailable"),
      type: "warning",
    });
  });
});
