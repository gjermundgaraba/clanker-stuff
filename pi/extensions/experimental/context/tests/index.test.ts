import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isFocusable } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import extension from "../index.js";

describe("context command", () => {
  it("opens from current session state and refreshes on each invocation", async () => {
    const host = createExtensionHost(extension, {
      allTools: ["read", "bash"],
      activeTools: ["read"],
    });

    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "RESTORED MESSAGE", timestamp: 0 });

    for (const prompt of ["FIRST PROMPT", "UPDATED PROMPT"]) {
      const ui = createCustomUiDriver({
        captureRender: "before",
        keys: ["\u001B"],
        width: 120,
        keybindings: createKeybindings({ "tui.select.cancel": ["escape"] }),
        onComponent(component) {
          expect(component.render(120).join("\n")).toContain(prompt);

          for (const key of ["j", "j", "j", "j"]) component.handleInput?.(key);
        },
      });

      await host.runCommand(
        "context",
        "",
        host.createContext({
          getSystemPrompt: () => prompt,
          getContextUsage: () => ({ contextWindow: 200_000, percent: 10, tokens: 20_000 }),
          sessionManager: { getBranch: () => session.getBranch() },
          ui: { custom: ui.custom },
        }),
      );
      expect(ui.getLastRender()).toContain("RESTORED MESSAGE");
      expect(ui.getLastRender()).toContain("Active tools (1)");
    }

    expect([...host.getRegisteredCommands().keys()]).toEqual(["context"]);
  });

  it("restores terminal mouse modes on shutdown even while the overlay is open", async () => {
    const host = createExtensionHost(extension);
    const tui = Object.assign(createMockTui(), { mode: "regular" });
    const write = vi.fn();
    Object.assign(tui.terminal, { write });

    const ui = createCustomUiDriver({
      tui,
      keys: ["\u001B"],
      keybindings: createKeybindings({ "tui.select.cancel": ["escape"] }),
      async onComponent(component) {
        if (isFocusable(component)) component.focused = true;
        expect(write).toHaveBeenLastCalledWith("\u001B[?1000h\u001B[?1006h");
        await host.emitSessionShutdown();
        expect(write).toHaveBeenLastCalledWith("\u001B[?1006l\u001B[?1000l");
      },
    });

    await host.runCommand(
      "context",
      "",
      host.createContext({ getSystemPrompt: () => "System prompt", ui: { custom: ui.custom } }),
    );
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("refuses to open outside TUI mode", async () => {
    const host = createExtensionHost(extension);
    await host.runCommand("context", "", host.createContext({ mode: "json" }));
    expect(host.getNotifications()).toEqual([
      { message: "/context requires TUI mode", type: "error" },
    ]);
  });
});
