import { Type } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
} from "../../../../tests/harness/tui.js";
import extension from "../index.js";

describe("context command", () => {
  it("opens from current session state and refreshes on each invocation", async () => {
    const host = createExtensionHost(extension);
    const session = SessionManager.inMemory();
    session.appendMessage({
      role: "user",
      content: "RESTORED MESSAGE",
      timestamp: 0,
    });

    const inspect = async (prompt: string) => {
      let opened = "";

      const ui = createCustomUiDriver({
        captureRender: "before",
        keys: ["\u001B"],
        width: 120,
        keybindings: createKeybindings({ "tui.select.cancel": ["escape"] }),
        onComponent(component) {
          opened = component.render(120).join("\n");

          for (const key of ["j", "j", "j", "j"]) {
            component.handleInput?.(key);
          }
        },
      });

      await host.runCommand(
        "context",
        "",
        host.createContext({
          getSystemPrompt: () => prompt,
          getContextUsage: () => ({
            contextWindow: 200_000,
            percent: 10,
            tokens: 20_000,
          }),
          sessionManager: { getBranch: () => session.getBranch() },
          ui: { custom: ui.custom },
        })
      );

      return `${opened}\n${ui.getLastRender()}`;
    };

    const pending = await inspect("PENDING PROMPT");
    expect(pending).toContain("RESTORED MESSAGE");
    expect(pending).toContain("PENDING PROMPT");
    expect(pending).not.toContain("Tool declarations (");

    session.appendMessage({
      role: "system",
      content: "RECORDED PROMPT",
      toolsAdded: [
        { name: "read", description: "read", parameters: Type.Object({}) },
      ],
      timestamp: 0,
    });
    const recorded = await inspect("PENDING PROMPT");
    expect(recorded).toContain("RECORDED PROMPT");
    expect(recorded).not.toContain("PENDING PROMPT");
    expect(recorded).toContain("Tool declarations (1)");
    expect([...host.getRegisteredCommands().keys()]).toStrictEqual(["context"]);
  });

  it("captures from startup, retains across overlay closes, and clears on navigation/session start", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ getSystemPrompt: () => "STATE ONLY" });
    await host.emitSessionStart(ctx);

    const payload = { input: "REQUEST ONLY" };
    await host.emit(
      "before_provider_request",
      { type: "before_provider_request", payload },
      ctx
    );
    payload.input = "LATER MUTATION";

    const inspect = async (present: boolean) => {
      const ui = createCustomUiDriver({
        keys: ["\u001B"],
        keybindings: createKeybindings({ "tui.select.cancel": ["escape"] }),
        onComponent(component) {
          expect(component.render(120).join("\n")).toContain("STATE ONLY");
          component.handleInput?.("v");
          component.render(120);
          component.handleInput?.("j");
          const observed = component.render(120).join("\n");
          expect(observed.includes("REQUEST ONLY")).toBe(present);
          expect(observed).not.toContain("LATER MUTATION");

          if (!present) {
            expect(observed).toContain("No request observed yet");
          }
        },
      });

      await host.runCommand("context", "", {
        ...ctx,
        ui: { ...ctx.ui, custom: ui.custom },
      });
    };

    await inspect(true);
    await inspect(true);

    for (const reset of ["session_tree", "session_start"]) {
      await host.emit(
        "before_provider_request",
        { type: "before_provider_request", payload: { input: "REQUEST ONLY" } },
        ctx
      );
      await host.emit(reset, { type: reset }, ctx);
      await inspect(false);
    }
  });

  it("captures registered tools and activation only when opened, without changing State", async () => {
    const host = createExtensionHost(extension, {
      allTools: ["read", "query"],
      activeTools: ["read"],
    });

    const open = async (activeCount: number) => {
      const ui = createCustomUiDriver({
        keys: ["\u001B"],
        keybindings: createKeybindings({ "tui.select.cancel": ["escape"] }),
        onComponent(component) {
          const state = component.render(120).join("\n");
          expect(state).not.toContain("query");
          component.handleInput?.("v");
          component.handleInput?.("v");
          const inventory = component.render(120).join("\n");
          expect(inventory).toContain("tools · registered inventory");
          expect(inventory).toContain(`2 registered · ${activeCount} active`);
          expect(inventory).toContain("query");
          component.handleInput?.("v");
          expect(component.render(120).join("\n")).toBe(state);
        },
      });

      await host.runCommand(
        "context",
        "",
        host.createContext({
          getSystemPrompt: () => "UNCHANGED STATE",
          ui: { custom: ui.custom },
        })
      );
    };

    await open(1);
    host.setActiveTools(["read", "query"]);
    await open(2);
  });

  it("refuses to open outside TUI mode", async () => {
    const host = createExtensionHost(extension);
    await host.runCommand("context", "", host.createContext({ mode: "json" }));
    expect(host.getNotifications()).toStrictEqual([
      { message: "/context requires TUI mode", type: "error" },
    ]);
  });
});
