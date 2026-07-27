import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createMessageEntry, createToolsEntry } from "./harness.js";

describe("tools state restoration", () => {
  it("restores saved inactive tools when they have been registered", async () => {
    const host = createExtensionHost(
      (pi) => {
        pi.registerTool({
          description: "extra-tool tool",
          async execute() {
            await Promise.resolve();
            return {
              content: [{ text: "ok", type: "text" }],
              details: {},
            };
          },
          label: "extra-tool",
          name: "extra-tool",
          parameters: Type.Object({}),
        });
        extension(pi);
      },
      {
        activeTools: ["read"],
        allTools: ["read", "extra-tool"],
        entries: [
          createMessageEntry({
            id: "root",
            parentId: null,
            text: "root",
          }),
          createToolsEntry({
            data: {
              enabledTools: ["read", "extra-tool"],
            },
            id: "tools-a",
            parentId: "root",
          }),
        ],
        leafId: "tools-a",
      }
    );

    await host.emitSessionStart();

    expect(host.getActiveTools()).toStrictEqual(["read", "extra-tool"]);
  });

  it("uses the session baseline for branches without saved tool state", async () => {
    const host = createExtensionHost(extension, {
      entries: [
        createMessageEntry({
          id: "root",
          parentId: null,
          text: "root",
        }),
        createMessageEntry({
          id: "branch-a",
          parentId: "root",
          text: "branch a",
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
          text: "branch b",
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
          text: "root",
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
