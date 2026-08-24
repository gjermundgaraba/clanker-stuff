import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import subagents from "../index.js";
import { createControlStore, rootBinding } from "../snapshot.js";

describe("subagent control persistence", () => {
  it("commits child completion without moving the active root leaf", async () => {
    const agentDir = getAgentDir();
    const configFile = path.join(agentDir, "subagents.json");
    const sessionDir = path.join(agentDir, `subagents-manager-test-${process.pid}-${Date.now()}`);
    await mkdir(agentDir, { recursive: true });
    await writeFile(configFile, JSON.stringify({ protocols: { "*": "v2" }, version: 1 }));

    const childRelease = Promise.withResolvers<null>();
    const rootPrepared = Promise.withResolvers<null>();
    const rootRelease = Promise.withResolvers<null>();
    const harness = await createAgentSessionHarness({
      extensionFactories: [subagents],
      sessionDir,
    });

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the race.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        async () => {
          rootPrepared.resolve(null);
          await rootRelease.promise;
          return fauxAssistantMessage("root interim");
        },
        fauxAssistantMessage("integrated"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootPrepared.promise;
      const preparedLeaf = harness.sessionManager.getLeafId();

      childRelease.resolve(null);
      const sessionFile = harness.sessionManager.getSessionFile();
      expect(sessionFile).toBeDefined();
      const store = createControlStore(
        getExtensionStoragePaths("subagents").dataDir,
        rootBinding(harness.sessionManager.getSessionId(), sessionFile),
      );
      await vi.waitFor(async () => {
        const snapshot = await store.load();
        expect(
          snapshot?.protocolLatch === "v2"
            ? snapshot.state.nodes.find((node) => node.path === "/root/worker")?.status
            : undefined,
        ).toBe("completed");
      });

      expect(harness.sessionManager.getLeafId()).toBe(preparedLeaf);
      rootRelease.resolve(null);
      await prompting;
      expect(
        JSON.stringify(
          harness.lastProviderPayload(Type.Object({}, { additionalProperties: true })),
        ),
      ).toContain("child answer");
    } finally {
      rootRelease.resolve(null);
      childRelease.resolve(null);
      await harness.session.extensionRunner.emit({
        reason: "quit",
        type: "session_shutdown",
      });
      harness.cleanup();
      await rm(configFile, { force: true });
      await rm(sessionDir, { force: true, recursive: true });
    }
  });
});
