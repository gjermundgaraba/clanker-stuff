import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import subagents from "../index.js";
import { readDelegation } from "../delegation.js";

describe("native delegation lifecycle", () => {
  it("keeps permission independent from manual thinking, model choice and repeated Ultra", async () => {
    const harness = await createAgentSessionHarness({
      extensionFactories: [subagents],
      models: [
        { id: "reasoner", reasoning: true },
        { id: "plain", reasoning: false },
      ],
    });

    const plain = harness.faux.getModel("plain");

    if (plain === undefined) throw new Error("Missing plain fixture");
    const requests: { prompt: string; reasoning: string | undefined }[] = [];
    harness.setResponses(
      Array.from({ length: 3 }, () => (context, options) => {
        requests.push({
          prompt: getCurrentSystemPrompt(context.messages),
          reasoning: options?.reasoning,
        });

        return fauxAssistantMessage("done");
      }),
    );

    const notifications: string[] = [];

    try {
      await harness.session.bindExtensions({
        uiContext: {
          ...harness.session.extensionRunner.getUIContext(),
          notify: (message) => notifications.push(message),
        },
      });
      harness.session.setThinkingLevel("low");
      await harness.prompt("/proactive");
      expect(harness.session.thinkingLevel).toBe("low");
      await harness.prompt("Work.");
      expect(requests[0]?.prompt).toContain("Proactive multi-agent delegation is enabled");
      await harness.prompt("/ultra");
      expect(harness.session.thinkingLevel).toBe("high");
      expect(notifications.at(-1)).toContain("native thinking is high");

      const entries = harness.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "subagents-delegation");

      await harness.prompt("/ultra");
      expect(readDelegation(harness.sessionManager, "explicit")).toBe("proactive");
      expect(
        harness.sessionManager
          .getBranch()
          .filter(
            (entry) => entry.type === "custom" && entry.customType === "subagents-delegation",
          ),
      ).toStrictEqual(entries);
      harness.session.setThinkingLevel("medium");
      await harness.prompt("Respect my new thinking.");
      expect(requests[1]?.reasoning).toBe("medium");
      expect(requests[1]?.prompt).toContain("Proactive multi-agent delegation is enabled");
      await harness.session.setModel(plain);
      await harness.prompt("/ultra");
      expect(harness.session.thinkingLevel).toBe("off");
      expect(notifications.at(-1)).toContain("native thinking is off");
      expect(readDelegation(harness.sessionManager, "explicit")).toBe("proactive");
      await harness.prompt("/proactive");
      await harness.prompt("Explicit work.");
      expect(requests[2]?.prompt).toContain("Explicit delegation is enabled");
      expect(harness.session.thinkingLevel).toBe("off");
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });

  it("ignores legacy metadata without changing native thinking on reload", async () => {
    const starts: string[] = [];

    const harness = await createAgentSessionHarness({
      extensionFactories: [
        subagents,
        (pi) => {
          pi.on("session_start", (event) => {
            starts.push(event.reason);
          });
        },
      ],
      models: [{ id: "reasoner", reasoning: true }],
    });

    try {
      await harness.session.bindExtensions({
        onError: (event) => {
          throw new Error(event.error);
        },
      });

      const legacyId = harness.sessionManager.appendCustomEntry("ultra", {
        enabled: true,
        previousThinking: "low",
      });

      const legacy = structuredClone(harness.sessionManager.getEntry(legacyId));

      expect(legacy).toMatchObject({ type: "custom", customType: "ultra" });
      harness.session.setThinkingLevel("high");
      await harness.session.reload();
      expect(starts.filter((reason) => reason === "reload")).toHaveLength(1);
      expect(harness.sessionManager.getEntry(legacyId)).toStrictEqual(legacy);
      expect(readDelegation(harness.sessionManager, "explicit")).toBe("explicit");
      expect(harness.session.thinkingLevel).toBe("high");
      harness.setResponses([
        (context) => {
          expect(getCurrentSystemPrompt(context.messages)).toContain(
            "Explicit delegation is enabled",
          );

          return fauxAssistantMessage("done");
        },
      ]);
      await harness.prompt("Work after cutover.");
      expect(harness.sessionManager.getEntry(legacyId)).toStrictEqual(legacy);
      expect(harness.session.thinkingLevel).toBe("high");
      expect(
        harness.sessionManager
          .getBranch()
          .filter(
            (entry) => entry.type === "custom" && entry.customType === "subagents-delegation",
          ),
      ).toStrictEqual([]);
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });

  it("follows branch policy on tree navigation, reload and persisted resume without restoring thinking", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "delegation-session-"));

    const starts: string[] = [];

    const options = {
      cwd: sessionDir,
      sessionDir,
      models: [{ id: "reasoner", reasoning: true }],
      extensionFactories: [
        subagents,
        (pi: Parameters<typeof subagents>[0]) => {
          pi.on("session_start", (event) => {
            starts.push(event.reason);
          });
        },
      ],
    };

    const first = await createAgentSessionHarness(options);

    try {
      await first.session.bindExtensions({
        onError: (event) => {
          throw new Error(event.error);
        },
      });
      first.session.setThinkingLevel("low");
      await first.prompt("/proactive");
      first.setResponses([fauxAssistantMessage("on")]);
      await first.prompt("Active branch.");
      const enabled = first.sessionManager.getLeafId();

      if (enabled === null) throw new Error("Missing active leaf");
      await first.prompt("/proactive");
      first.session.setThinkingLevel("medium");
      first.setResponses([fauxAssistantMessage("off")]);
      await first.prompt("Explicit branch.");
      const disabled = first.sessionManager.getLeafId();

      if (disabled === null) throw new Error("Missing explicit leaf");
      await first.session.navigateTree(enabled);
      expect(readDelegation(first.sessionManager, "explicit")).toBe("proactive");
      expect(first.session.thinkingLevel).toBe("medium");
      await first.session.reload();
      expect(starts.filter((reason) => reason === "reload")).toHaveLength(1);
      expect(readDelegation(first.sessionManager, "explicit")).toBe("proactive");
      expect(first.session.thinkingLevel).toBe("medium");
      await first.session.navigateTree(disabled);
      expect(readDelegation(first.sessionManager, "proactive")).toBe("explicit");
      expect(first.session.thinkingLevel).toBe("medium");
      await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      first.cleanup();
      const resumed = await createAgentSessionHarness({ ...options, continueSession: true });

      try {
        expect(readDelegation(resumed.sessionManager, "proactive")).toBe("explicit");
        expect(resumed.session.thinkingLevel).toBe("medium");
        await resumed.prompt("/proactive");
        expect(readDelegation(resumed.sessionManager, "explicit")).toBe("proactive");
        expect(resumed.session.thinkingLevel).toBe("medium");
      } finally {
        await resumed.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        resumed.cleanup();
      }
    } finally {
      first.cleanup();
      await rm(sessionDir, { recursive: true, force: true });
    }
  });
});
