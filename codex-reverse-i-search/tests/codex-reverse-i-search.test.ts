import type {
  SessionEntry,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

/* oxlint-disable vitest/max-expects -- interaction tests assert each state transition directly */

const userEntry = (
  id: string,
  parentId: string | null,
  text: string,
  timestamp: number
): SessionEntry => ({
  id,
  message: {
    content: text,
    role: "user",
    timestamp,
  },
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  type: "message",
});

const createHarness = async (entries: SessionEntry[] = []) => {
  const host = createExtensionHost(extension, {
    entries,
    leafId: entries.at(-1)?.id ?? null,
  });
  const ctx = host.createContext();
  await host.emitSessionStart(ctx);
  return { ctx, host };
};

describe("codex reverse-i-search", () => {
  beforeEach(() => {
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
  });

  it("searches newest-first and accepts without submitting", async () => {
    const { ctx, host } = await createHarness([
      userEntry("older", null, "Deploy production", 100),
      userEntry("newer", "older", "Check deploy status", 200),
    ]);
    ctx.ui.setEditorText("unfinished draft");

    await host.runShortcut("ctrl+r", ctx);
    expect(host.terminalInput("deploy").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");

    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("Deploy production");

    host.terminalInput("\u0013");
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");

    expect(host.terminalInput("\r").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");
    expect(host.getWidget("codex-reverse-i-search")).toBeUndefined();
    expect(host.terminalInput("\r").consumed).toBeFalsy();
  });

  it("keeps no-match search open and restores the original draft", async () => {
    const { ctx, host } = await createHarness([
      userEntry("one", null, "Known prompt", 100),
    ]);
    ctx.ui.setEditorText("unfinished draft");

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("missing");
    await vi.waitFor(() => {
      expect(host.getWidget("codex-reverse-i-search")).toContain("no match");
    });

    expect(host.terminalInput("\r").consumed).toBeTruthy();
    expect(host.getWidget("codex-reverse-i-search")).toContain("no match");

    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(host.getWidget("codex-reverse-i-search")).toBe("reverse-i-search: ");

    host.terminalInput("known");
    expect(ctx.ui.getEditorText()).toBe("Known prompt");
    expect(host.terminalInput("\u001B").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(host.getWidget("codex-reverse-i-search")).toBeUndefined();
  });

  it("matches case-insensitively, deduplicates exact text, and holds boundaries", async () => {
    const { ctx, host } = await createHarness([
      userEntry("case", null, "build release", 100),
      userEntry("duplicate", "case", "Build Release", 200),
      userEntry("newest", "duplicate", "Build Release", 300),
    ]);

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("BUILD");
    expect(ctx.ui.getEditorText()).toBe("Build Release");

    host.terminalInput("\u001B[A");
    expect(ctx.ui.getEditorText()).toBe("build release");
    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("build release");

    host.terminalInput("\u001B[B");
    expect(ctx.ui.getEditorText()).toBe("Build Release");
  });

  it("adds interactive prompts and bash commands but ignores extension input", async () => {
    const { ctx, host } = await createHarness();

    await host.emitInput(
      { source: "interactive", text: "new local prompt", type: "input" },
      ctx
    );
    await host.emitInput(
      { source: "extension", text: "extension prompt", type: "input" },
      ctx
    );
    await host.emit(
      "user_bash",
      {
        command: "pnpm test",
        cwd: process.cwd(),
        excludeFromContext: true,
        type: "user_bash",
      },
      ctx
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

  it("loads prompts from other persisted sessions", async () => {
    const session: SessionInfo = {
      allMessagesText: "archived prompt",
      created: new Date(100),
      cwd: "/other/project",
      firstMessage: "archived prompt",
      id: "other",
      messageCount: 1,
      modified: new Date(100),
      path: "/sessions/other.jsonl",
    };
    vi.mocked(SessionManager.listAll).mockResolvedValue([session]);
    vi.spyOn(SessionManager, "open").mockReturnValue({
      getEntries: () => [userEntry("archived", null, "archived prompt", 100)],
    } as SessionManager);
    const { ctx, host } = await createHarness();

    await vi.waitFor(() => {
      expect(SessionManager.open).toHaveBeenCalledWith(session.path);
    });
    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("archived");

    expect(ctx.ui.getEditorText()).toBe("archived prompt");
  });

  it("removes one Unicode code point on backspace", async () => {
    const { ctx, host } = await createHarness([
      userEntry("rocket", null, "ship 🚀 now", 100),
    ]);
    ctx.ui.setEditorText("draft");

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("🚀");
    expect(ctx.ui.getEditorText()).toBe("ship 🚀 now");

    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });

  it("accepts bracketed paste without leaking terminal sequences", async () => {
    const { ctx, host } = await createHarness([
      userEntry("deploy", null, "deploy production", 100),
    ]);
    ctx.ui.setEditorText("draft");

    await host.runShortcut("ctrl+r", ctx);
    host.terminalInput("\u001B[200~de\u0080ploy\u001B[201~");
    expect(ctx.ui.getEditorText()).toBe("deploy production");

    host.terminalInput("\u0015");
    host.terminalInput("\u001B[3~");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });
});
