import type { ExtensionContext, InputEvent, UserBashEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const search = vi.hoisted(() => ({
  dispose: vi.fn<(ctx: ExtensionContext) => Promise<void>>(async () => await Promise.resolve()),
  importHistory: vi.fn<(ctx: ExtensionContext) => Promise<void>>(
    async () => await Promise.resolve(),
  ),
  open: vi.fn<(ctx: ExtensionContext) => void>(),
  recordBash: vi.fn<(event: UserBashEvent, ctx: ExtensionContext) => void>(),
  recordInput: vi.fn<(event: InputEvent, ctx: ExtensionContext) => void>(),
  start: vi.fn<(ctx: ExtensionContext) => void>(),
}));
const createSearch = vi.hoisted(() => vi.fn<() => void>());

vi.mock(import("../controller.js"), () => ({
  createReverseSearch: () => {
    createSearch();
    return search;
  },
}));

describe("codex-reverse-i-search registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers and delegates reverse-search behavior", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const input = {
      source: "interactive",
      text: "prompt",
      type: "input",
    } satisfies InputEvent;
    const bash = {
      command: "pnpm test",
      cwd: ctx.cwd,
      excludeFromContext: false,
      type: "user_bash",
    } satisfies UserBashEvent;

    await host.emitSessionStart(ctx);
    await host.runShortcut("ctrl+r", ctx);
    await host.runCommand("reverse-i-search-import", "", ctx);
    await host.emitInput(input, ctx);
    await host.emit("user_bash", bash, ctx);
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("reverse-i-search-import")?.description).toBe(
      "Import prompt history from existing sessions",
    );
    expect({
      dispose: search.dispose.mock.calls,
      importHistory: search.importHistory.mock.calls,
      open: search.open.mock.calls,
      recordBash: search.recordBash.mock.calls,
      recordInput: search.recordInput.mock.calls,
      start: search.start.mock.calls,
    }).toStrictEqual({
      dispose: [[ctx]],
      importHistory: [[ctx]],
      open: [[ctx]],
      recordBash: [[bash, ctx]],
      recordInput: [[input, ctx]],
      start: [[ctx]],
    });
  });

  it("does not finish loading after shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    await host.emitSessionStart(ctx);

    const shortcut = host.runShortcut("ctrl+r", ctx);
    await host.emitSessionShutdown(ctx);
    await shortcut;

    expect(createSearch).not.toHaveBeenCalled();
  });
});
