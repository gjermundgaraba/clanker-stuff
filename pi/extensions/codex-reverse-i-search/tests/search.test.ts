import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { HistoryItem } from "../history.js";
import { createSearch } from "../search.js";

const item = (text: string, timestamp: number): HistoryItem => ({
  text,
  timestamp,
});

const createHarness = (history: HistoryItem[]) => {
  const host = createExtensionHost(() => Promise.resolve());
  const ctx = host.createContext();
  const search = createSearch(() => history);
  ctx.ui.onTerminalInput(search.handleInput);
  return {
    begin: () => search.begin(ctx.ui),
    ctx,
    host,
    reset: search.reset,
  };
};

describe("reverse search", () => {
  it("searches newest-first and accepts without submitting", () => {
    const { begin, ctx, host } = createHarness([
      item("Check deploy status", 200),
      item("Deploy production", 100),
    ]);
    ctx.ui.setEditorText("unfinished draft");

    begin();
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

  it("keeps no-match search open and restores the original draft", () => {
    const { begin, ctx, host } = createHarness([item("Known prompt", 100)]);
    ctx.ui.setEditorText("unfinished draft");

    begin();
    host.terminalInput("missing");
    expect(host.getWidget("codex-reverse-i-search")).toContain("no match");

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

  it("matches case-insensitively and holds selection boundaries", () => {
    const { begin, ctx, host } = createHarness([
      item("Build Release", 300),
      item("build release", 100),
    ]);

    begin();
    host.terminalInput("BUILD");
    expect(ctx.ui.getEditorText()).toBe("Build Release");

    host.terminalInput("\u001B[A");
    expect(ctx.ui.getEditorText()).toBe("build release");
    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("build release");

    host.terminalInput("\u001B[B");
    expect(ctx.ui.getEditorText()).toBe("Build Release");
  });

  it("matches Unicode text changed by lowercasing", () => {
    const { begin, ctx, host } = createHarness([item("İstanbul", 100)]);

    begin();
    host.terminalInput("İ");

    expect(ctx.ui.getEditorText()).toBe("İstanbul");
  });

  it("treats regex syntax as literal search text", () => {
    const { begin, ctx, host } = createHarness([item("find [literal].* text", 100)]);

    begin();
    host.terminalInput("[literal].*");
    expect(ctx.ui.getEditorText()).toBe("find [literal].* text");
  });

  it("broadens incremental results after backspace", () => {
    const { begin, ctx, host } = createHarness([
      item("alpha release", 200),
      item("alpha beta", 100),
    ]);

    begin();
    host.terminalInput("alpha b");
    expect(ctx.ui.getEditorText()).toBe("alpha beta");

    host.terminalInput("\u007F");
    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("alpha release");
  });

  it("removes one Unicode grapheme on backspace", () => {
    const family = "👨‍👩‍👧‍👦";
    const { begin, ctx, host } = createHarness([item(`ship ${family} now`, 100)]);
    ctx.ui.setEditorText("draft");

    begin();
    host.terminalInput(family);
    expect(ctx.ui.getEditorText()).toBe(`ship ${family} now`);

    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });

  it("restores the draft when reset", () => {
    const { begin, ctx, host, reset } = createHarness([item("Known prompt", 100)]);
    ctx.ui.setEditorText("unfinished draft");

    begin();
    host.terminalInput("known");
    reset();

    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(host.getWidget("codex-reverse-i-search")).toBeUndefined();
  });

  it("accepts bracketed paste without leaking terminal sequences", () => {
    const { begin, ctx, host } = createHarness([item("deploy production", 100)]);
    ctx.ui.setEditorText("draft");

    begin();
    host.terminalInput("\u001B[200~de\u0080ploy\u001B[201~");
    expect(ctx.ui.getEditorText()).toBe("deploy production");

    host.terminalInput("\u0015");
    host.terminalInput("\u001B[3~");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });
});
