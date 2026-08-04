import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createMessageEntry, createToolsEntry } from "./harness.js";

describe("tool selection restoration", () => {
  it("restores saved inactive tools when they have been registered", async () => {
    const host = createExtensionHost(extension, {
      activeTools: ["read"],
      allTools: ["read", "extra-tool"],
      entries: [
        createMessageEntry({ id: "root", parentId: null }),
        createToolsEntry({
          data: {
            enabledTools: ["read", "extra-tool"],
          },
          id: "tools-a",
          parentId: "root",
        }),
      ],
      leafId: "tools-a",
    });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(["read", "extra-tool"]);
  });

  it("uses the session baseline for branches without saved tool state", async () => {
    const host = createExtensionHost(extension, {
      entries: [
        createMessageEntry({
          id: "root",
          parentId: null,
        }),
        createMessageEntry({
          id: "branch-a",
          parentId: "root",
        }),
        createToolsEntry({
          data: {
            enabledTools: ["read", "edit", "write"],
          },
          id: "tools-a",
          parentId: "branch-a",
        }),
        createMessageEntry({
          id: "branch-b",
          parentId: "root",
        }),
      ],
      leafId: "tools-a",
    });

    await host.emitSessionStart();
    expect(host.getActiveTools()).toStrictEqual(["read", "edit", "write"]);

    host.setLeafId("branch-b");
    await host.emitSessionTree();

    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });

  it("filters unavailable tools from saved state", async () => {
    const host = createExtensionHost(extension, {
      entries: [
        createMessageEntry({
          id: "root",
          parentId: null,
        }),
        createToolsEntry({
          data: {
            enabledTools: ["read", "missing-tool", "write"],
          },
          id: "tools-a",
          parentId: "root",
        }),
      ],
      leafId: "tools-a",
    });

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(["read", "write"]);
  });
});
