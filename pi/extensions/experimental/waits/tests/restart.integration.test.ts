import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import extension from "../index.js";
import { OPENED } from "../journal.js";
import { WAKE_TYPE } from "../runtime.js";
import type { StartRequest } from "../spec.js";

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

const wakes = (h: AgentSessionHarness) =>
  h.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom_message" && entry.customType === WAKE_TYPE
    );

const prompts = (h: AgentSessionHarness) =>
  h.sessionManager
    .getEntries()
    .filter(
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

const settledAfterWake = (h: AgentSessionHarness, count: number) => () =>
  wakes(h).length === count &&
  h.getPendingResponseCount() === 0 &&
  !h.session.isStreaming;

const openWait = async (
  h: AgentSessionHarness,
  args: Pick<StartRequest, "condition" | "timeoutSeconds">
) => {
  h.setResponses([
    fauxAssistantMessage(
      fauxToolCall("wait_start", {
        label: "job result",
        instruction: "Consume the result once.",
        intervalSeconds: 1,
        ...args,
      }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Waiting; ending my turn."),
  ]);
  await h.prompt("Start the job and wait for it");
};

describe("a wait across restarts", () => {
  it("wakes the relaunched session once, unprompted, and never again", async () => {
    const directory = await createTempDir("waits-restart-");
    const marker = path.join(directory, "result.json");

    try {
      const first = await launch(directory, false);
      await openWait(first, { condition: `test -f ${JSON.stringify(marker)}` });

      const file = first.sessionManager.getSessionFile();

      if (file === undefined) {
        throw new Error("The session was not persisted");
      }

      const beforeQuit = await readFile(file, "utf8");
      await quit(first);
      await expect(readFile(file, "utf8")).resolves.toBe(beforeQuit);

      await writeFile(marker, "{}");

      const second = await launch(directory, true);
      second.setResponses([fauxAssistantMessage("Consumed it.")]);

      try {
        await until(settledAfterWake(second, 1));
        expect(prompts(second)).toHaveLength(1);
        expect(JSON.stringify(wakes(second)[0])).toContain(
          "is satisfied: its condition exited 0"
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

  it("wakes once with an expiry when the deadline passed while Pi was closed", async () => {
    const directory = await createTempDir("waits-expiry-");

    try {
      const first = await launch(directory, false);
      await openWait(first, { condition: "false", timeoutSeconds: 1 });
      await quit(first);
      await delay(1200);

      const second = await launch(directory, true);
      second.setResponses([fauxAssistantMessage("Noted.")]);

      try {
        await until(settledAfterWake(second, 1));
        expect(JSON.stringify(wakes(second)[0])).toContain(
          "expired before its condition exited 0"
        );
      } finally {
        await quit(second);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not wake again after navigating back to before the wait ended", async () => {
    const directory = await createTempDir("waits-tree-");
    const marker = path.join(directory, "result.json");
    const h = await launch(directory, false);

    try {
      await openWait(h, { condition: `test -f ${JSON.stringify(marker)}` });
      h.setResponses([fauxAssistantMessage("Consumed it.")]);
      await writeFile(marker, "{}");
      await until(settledAfterWake(h, 1));

      const openedEntry = h.sessionManager
        .getEntries()
        .find(
          (entry) => entry.type === "custom" && entry.customType === OPENED
        );

      if (openedEntry === undefined) {
        throw new Error("The wait was not journaled");
      }

      await h.session.navigateTree(openedEntry.id);
      await h.session.reload();
      await delay(1500);

      expect(wakes(h)).toHaveLength(1);
    } finally {
      await quit(h);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
