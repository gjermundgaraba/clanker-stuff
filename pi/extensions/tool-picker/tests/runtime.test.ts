import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import extension from "../index.js";

const messageEntry = (id: string, parentId: string | null): SessionEntry => ({
  id,
  message: {
    content: "message",
    role: "user",
    timestamp: 1,
  },
  parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "message",
});

const toolsEntry = (
  id: string,
  parentId: string | null,
  tools: Record<string, boolean>,
): CustomEntry<Record<string, boolean>> => ({
  customType: "tool-picker-config",
  data: tools,
  id,
  parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "custom",
});

describe("tool selection", () => {
  it("adds only /tools, without registering tools or changing the initial selection", async () => {
    const host = createExtensionHost(extension, {
      activeTools: ["read", "extra-tool"],
      allTools: ["read", "bash", "extra-tool"],
      externalTools: ["extra-tool"],
    });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(["read", "extra-tool"]);
    expect(host.getRegisteredTools().size).toBe(0);
    expect([...host.getRegisteredCommands().keys()]).toStrictEqual(["tools"]);
    expect(host.getAppendedEntries()).toStrictEqual([]);
  });

  it("applies toggles immediately and restores them in a fresh instance and across branches", async () => {
    const entries = [messageEntry("root", null), messageEntry("branch-b", "root")];
    const host = createExtensionHost(extension, { entries, leafId: "root" });
    await host.emitSessionStart();
    initTheme("dark");
    const ui = createCustomUiDriver({ keys: [" ", "\u001B"], captureRender: "before" });

    await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));

    expect(ui.getLastRender()).toContain("Tool Configuration");
    expect(host.getActiveTools()).toStrictEqual(["bash", "edit", "write"]);
    const saved = host.getAppendedEntries().at(-1);
    expect(saved).toMatchObject({
      customType: "tool-picker-config",
      data: { read: false, bash: true, edit: true, write: true },
    });

    if (!saved) throw new Error("Missing selection entry");
    expect(host.getAppendedEntries()[0]).toMatchObject({
      customType: "tool-picker-baseline",
      data: { read: true, bash: true, edit: true, write: true },
    });

    const reloaded = createExtensionHost(extension, {
      activeTools: host.getActiveTools(),
      entries: [...entries, ...host.getAppendedEntries()],
      leafId: saved.id,
    });

    await reloaded.emitSessionStart();
    expect(reloaded.getActiveTools()).toStrictEqual(["bash", "edit", "write"]);

    reloaded.setLeafId("branch-b");
    await reloaded.emitSessionTree();
    expect(new Set(reloaded.getActiveTools())).toStrictEqual(
      new Set(["read", "bash", "edit", "write"]),
    );
    const branchUi = createCustomUiDriver({ keys: [" ", "\u001B"] });
    await reloaded.runCommand(
      "tools",
      "",
      reloaded.createContext({ ui: { custom: branchUi.custom } }),
    );
    expect(reloaded.getAppendedEntries()).toMatchObject([{ customType: "tool-picker-config" }]);
    reloaded.setLeafId(saved.id);
    await reloaded.emitSessionTree();
    expect(reloaded.getActiveTools()).not.toContain("read");
  });

  it("persists external tool choices and discovers newly registered tools", async () => {
    const host = createExtensionHost(
      (pi) => {
        extension(pi);
        pi.registerCommand("add-tool", {
          description: "Register an external tool",
          handler: async () => {
            pi.registerTool({
              name: "late-tool",
              label: "Late Tool",
              description: "An external tool",
              parameters: Type.Object({}),
              execute: async () => ({ content: [], details: {} }),
            });
          },
        });
      },
      { activeTools: [], allTools: [] },
    );

    await host.emitSessionStart();
    await host.runCommand("add-tool");
    initTheme("dark");
    const ui = createCustomUiDriver({ keys: [" ", "\u001B"], captureRender: "before" });
    await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));
    expect(ui.getLastRender()).toContain("late-tool");
    expect(host.getActiveTools()).toStrictEqual([]);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "tool-picker-config",
      data: { "late-tool": false },
    });
  });

  it.each(["session start", "branch navigation"])(
    "saves the baseline before restoring existing choices on %s",
    async (restoreOn) => {
      const host = createExtensionHost(extension, {
        activeTools: ["read", "bash"],
        allTools: ["read", "bash"],
        entries: [
          messageEntry("root", null),
          toolsEntry("selected", "root", { read: false, bash: true }),
        ],
        leafId: restoreOn === "session start" ? "selected" : "root",
      });

      await host.emitSessionStart();

      if (restoreOn === "branch navigation") {
        expect(host.getAppendedEntries()).toStrictEqual([]);
        host.setLeafId("selected");
        await host.emitSessionTree();
      }

      expect(host.getActiveTools()).toStrictEqual(["bash"]);
      expect(host.getAppendedEntries()).toMatchObject([
        { customType: "tool-picker-baseline", data: { read: true, bash: true } },
      ]);
    },
  );

  it("uses the current active set when another extension changes tools during the picker", async () => {
    const host = createExtensionHost(extension, {
      activeTools: ["read", "bash"],
      allTools: ["read", "bash"],
    });

    await host.emitSessionStart();
    initTheme("dark");

    const ui = createCustomUiDriver({
      onComponent: () => {
        host.setActiveTools(["read"]);
      },
      keys: [" ", "\u001B"],
    });

    await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));

    expect(host.getActiveTools()).toStrictEqual([]);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      customType: "tool-picker-config",
      data: { read: false, bash: false },
    });
  });

  it("does not change or save tools when the picker is dismissed without a toggle", async () => {
    const host = createExtensionHost(extension);
    await host.emitSessionStart();
    host.setActiveTools(["bash"]);
    initTheme("dark");
    const ui = createCustomUiDriver({ keys: ["\u001B"] });
    await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));
    expect(host.getActiveTools()).toStrictEqual(["bash"]);
    expect(host.getAppendedEntries()).toStrictEqual([]);
  });

  it("restores registered tools from branch state", async () => {
    const host = createExtensionHost(extension, {
      activeTools: ["read"],
      allTools: ["read", "extra-tool"],
      externalTools: ["extra-tool"],
      entries: [
        messageEntry("root", null),
        toolsEntry("tools-a", "root", {
          "extra-tool": true,
          read: true,
        }),
      ],
      leafId: "tools-a",
    });

    await host.emitSessionStart();

    expect(new Set(host.getActiveTools())).toStrictEqual(new Set(["read", "extra-tool"]));
  });

  it("uses the session baseline on branches without tool state", async () => {
    const host = createExtensionHost(extension, {
      entries: [
        messageEntry("root", null),
        messageEntry("branch-a", "root"),
        toolsEntry("tools-a", "branch-a", {
          bash: false,
          edit: true,
          read: true,
          write: true,
        }),
        messageEntry("branch-b", "root"),
      ],
      leafId: "tools-a",
    });

    await host.emitSessionStart();
    expect(host.getActiveTools()).not.toContain("bash");

    host.setLeafId("branch-b");
    await host.emitSessionTree();

    expect(new Set(host.getActiveTools())).toStrictEqual(
      new Set(["read", "bash", "edit", "write"]),
    );
  });

  it("ignores unavailable tool names in saved selections", async () => {
    const host = createExtensionHost(extension, {
      entries: [
        {
          id: "picker",
          parentId: null,
          timestamp: "2026-04-20T00:00:00.000Z",
          type: "custom",
          customType: "tool-picker-config",
          data: { read: true, missing: true },
        },
      ],
      leafId: "picker",
    });

    await host.emitSessionStart();
    expect(host.getActiveTools()).toContain("read");
    expect(host.getActiveTools()).not.toContain("missing");
  });

  it("preserves unavailable choices from the current branch when saving another toggle", async () => {
    const entries = [
      messageEntry("root", null),
      toolsEntry("branch-a", "root", { read: true, external: false }),
      toolsEntry("branch-b", "root", { read: true, external: true }),
    ];

    const host = createExtensionHost(extension, {
      allTools: ["read"],
      activeTools: ["read"],
      entries,
      leafId: "branch-a",
    });

    await host.emitSessionStart();
    initTheme("dark");

    for (const [branch, enabled] of [
      ["branch-a", false],
      ["branch-b", true],
    ] as const) {
      host.setLeafId(branch);
      await host.emitSessionTree();
      const ui = createCustomUiDriver({ keys: [" ", "\u001B"] });
      await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));
      const saved = host.getAppendedEntries().at(-1);
      expect(saved).toMatchObject({
        customType: "tool-picker-config",
        data: { read: false, external: enabled },
      });

      if (!saved) throw new Error("Missing selection entry");

      const resumed = createExtensionHost(extension, {
        allTools: ["read", "external"],
        activeTools: ["read", "external"],
        externalTools: ["external"],
        entries: [...entries, ...host.getAppendedEntries()],
        leafId: saved.id,
      });

      await resumed.emitSessionStart();
      expect(resumed.getActiveTools().includes("external")).toBe(enabled);
    }
  });

  it.each([true, false])(
    "captures newly available tools with initial state %s without replacing old defaults",
    async (enabled) => {
      const entries: SessionEntry[] = [
        messageEntry("root", null),
        { ...toolsEntry("baseline", "root", { read: true }), customType: "tool-picker-baseline" },
        messageEntry("branch-a", "baseline"),
        messageEntry("branch-b", "baseline"),
        toolsEntry("branch-c", "baseline", { read: false }),
      ];

      const host = createExtensionHost(extension, {
        allTools: ["read", "external"],
        activeTools: enabled ? ["external"] : [],
        externalTools: ["external"],
        entries,
        leafId: "branch-a",
      });

      await host.emitSessionStart();
      expect(host.getActiveTools().includes("read")).toBe(true);
      initTheme("dark");
      const ui = createCustomUiDriver({ keys: ["\u001B[B", " ", "\u001B"] });
      await host.runCommand("tools", "", host.createContext({ ui: { custom: ui.custom } }));
      expect(host.getActiveTools().includes("external")).toBe(!enabled);
      expect(host.getAppendedEntries()[0]).toMatchObject({
        customType: "tool-picker-baseline",
        data: { read: true, external: enabled },
      });
      const saved = host.getAppendedEntries().at(-1);

      if (!saved) throw new Error("Missing selection entry");

      const reloaded = createExtensionHost(extension, {
        allTools: ["read", "external"],
        activeTools: host.getActiveTools(),
        externalTools: ["external"],
        entries: [...entries, ...host.getAppendedEntries()],
        leafId: saved.id,
      });

      await reloaded.emitSessionStart();
      expect(reloaded.getActiveTools().includes("external")).toBe(!enabled);
      reloaded.setLeafId("branch-b");
      await reloaded.emitSessionTree();
      expect(reloaded.getActiveTools().includes("external")).toBe(enabled);
      expect(reloaded.getActiveTools()).toContain("read");
      reloaded.setLeafId(saved.id);
      await reloaded.emitSessionTree();
      reloaded.setLeafId("branch-c");
      await reloaded.emitSessionTree();
      expect(reloaded.getActiveTools().includes("external")).toBe(enabled);
      expect(reloaded.getActiveTools()).not.toContain("read");
      expect(reloaded.getAppendedEntries()).toStrictEqual([]);
    },
  );

  it.each(["tool-picker-config", "tool-picker-baseline"])(
    "ignores malformed %s without changing the initial selection",
    async (customType) => {
      const host = createExtensionHost(extension, {
        activeTools: ["read"],
        entries: [
          {
            id: "invalid",
            parentId: null,
            timestamp: "2026-04-20T00:00:00.000Z",
            type: "custom",
            customType,
            data: { read: "false" },
          },
        ],
        leafId: "invalid",
      });

      await host.emitSessionStart();
      expect(host.getActiveTools()).toStrictEqual(["read"]);
    },
  );

  it.each(["rpc", "json", "print"] as const)("rejects the picker in %s mode", async (mode) => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ mode });

    await host.runCommand("tools", "", ctx);

    expect(host.getNotifications()).toContainEqual({
      message: "/tools requires TUI mode",
      type: "error",
    });
  });
});
