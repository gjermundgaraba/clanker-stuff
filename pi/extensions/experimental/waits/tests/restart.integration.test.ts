import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import extension from "../index.js";
import { WAKE_TYPE } from "../runtime.js";

const launch = async (directory: string, continueSession: boolean) =>
  await createAgentSessionHarness({
    cwd: directory,
    sessionDir: path.join(directory, "sessions"),
    continueSession,
    extensionFactories: [extension],
    mode: "rpc",
  });

const quit = async (h: AgentSessionHarness) => {
  await h.session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  h.cleanup();
};

const entries = (h: AgentSessionHarness) => h.sessionManager.getEntries();

const wakes = (h: AgentSessionHarness) =>
  entries(h).filter(
    (entry) => entry.type === "custom_message" && entry.customType === WAKE_TYPE
  );

const prompts = (h: AgentSessionHarness) =>
  entries(h).filter(
    (entry) => entry.type === "message" && entry.message.role === "user"
  );

const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition");
    }

    await delay(25);
  }
};

describe("a wait across quitting and relaunching the same session", () => {
  it("wakes the relaunched session once, unprompted, and never again", async () => {
    const directory = await createTempDir("waits-restart-");
    const marker = path.join(directory, "result.json");

    try {
      const first = await launch(directory, false);
      first.setResponses([
        fauxAssistantMessage(
          fauxToolCall("wait_start", {
            label: "job result",
            condition: `test -f ${JSON.stringify(marker)}`,
            instruction: "Consume the result once.",
            intervalSeconds: 1,
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("Waiting; ending my turn."),
      ]);
      await first.prompt("Start the job and wait for it");

      const file = first.sessionManager.getSessionFile();

      if (file === undefined) {
        throw new Error("The session was not persisted");
      }

      const beforeQuit = await readFile(file, "utf8");
      expect(beforeQuit).toContain('"customType":"waits:wait"');
      await quit(first);
      await expect(readFile(file, "utf8")).resolves.toBe(beforeQuit);

      await writeFile(marker, "{}");

      const second = await launch(directory, true);
      second.setResponses([fauxAssistantMessage("Consumed it.")]);

      try {
        await until(
          () =>
            wakes(second).length === 1 &&
            second.getPendingResponseCount() === 0 &&
            !second.session.isStreaming
        );
        expect(prompts(second)).toHaveLength(1);
        expect(JSON.stringify(wakes(second)[0])).toContain(
          "Consume the result once."
        );
      } finally {
        await quit(second);
      }

      const third = await launch(directory, true);

      try {
        await delay(1500);
        expect(wakes(third)).toHaveLength(1);
      } finally {
        await quit(third);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores nothing into a new session", async () => {
    const directory = await createTempDir("waits-new-");

    try {
      const first = await launch(directory, false);
      first.setResponses([
        fauxAssistantMessage(
          fauxToolCall("wait_start", {
            label: "never",
            condition: "true",
            instruction: "Nothing.",
          }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("Waiting."),
      ]);
      await first.prompt("Wait for something");
      await quit(first);

      const fresh = await launch(directory, false);

      try {
        await delay(500);
        expect(wakes(fresh)).toHaveLength(0);
      } finally {
        await quit(fresh);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
