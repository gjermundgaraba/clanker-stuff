import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
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
  tools: Record<string, Record<string, boolean>>,
): SessionEntry => ({
  customType: "tools-config",
  data: { tools },
  id,
  parentId,
  timestamp: "2026-04-20T00:00:00.000Z",
  type: "custom",
});

describe("tool selection", () => {
  it("restores registered tools from branch state", async () => {
    const host = createExtensionHost(extension, {
      activeTools: ["read"],
      allTools: ["read", "extra-tool"],
      externalTools: ["extra-tool"],
      entries: [
        messageEntry("root", null),
        toolsEntry("tools-a", "root", {
          external: { "extra-tool": true },
          pi: { read: true },
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
          pi: {
            bash: false,
            edit: true,
            read: true,
            write: true,
          },
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

  it("rejects the picker outside TUI mode", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ mode: "rpc" });

    await host.runCommand("tools", "", ctx);

    expect(host.getNotifications()).toContainEqual({
      message: "/tools requires TUI mode",
      type: "error",
    });
  });
});
