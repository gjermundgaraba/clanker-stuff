import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createChildRuntime, SUBAGENT_IDENTITY_ENTRY_TYPE } from "../runtime.js";

const runtimeRequest = (
  harness: Awaited<ReturnType<typeof createAgentSessionHarness>>,
  identity = "/root/child",
) => ({
  bridge: () => Promise.resolve(),
  cwd: path.dirname(harness.agentDir),
  dataDir: path.join(harness.agentDir, "data", "subagents"),
  history: [],
  identity,
  model: harness.faux.getModel(),
  modelRegistry: harness.session.extensionRunner.getModelRegistry(),
  prompt: "You are a child.",
  tools: [],
  trusted: false,
});

describe("child runtime", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("materializes an identity-bound transcript before publication", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const runtime = await createChildRuntime(runtimeRequest(harness));
    try {
      expect(existsSync(runtime.sessionFile)).toBeTruthy();
      await expect(readFile(runtime.sessionFile, "utf-8")).resolves.toContain(
        `"customType":"${SUBAGENT_IDENTITY_ENTRY_TYPE}"`,
      );
      runtime.commit();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("accepts only a persisted user turn and returns its final assistant result", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([fauxAssistantMessage("child answer")]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "task" });
      await expect(turn.accepted).resolves.toBeUndefined();
      await expect(turn.settled).resolves.toStrictEqual({
        status: "completed",
        text: "child answer",
      });
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toBeTruthy();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("accepts a second turn after the first result is persisted", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
    ]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const first = runtime.startTurn({ text: "first task" });
      await expect(first.accepted).resolves.toBeUndefined();
      await expect(first.settled).resolves.toMatchObject({
        text: "first answer",
      });

      const second = runtime.startTurn({ text: "second task" });
      await expect(second.accepted).resolves.toBeUndefined();
      await expect(second.settled).resolves.toMatchObject({
        text: "second answer",
      });
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("steers persisted mail into an active child turn", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const firstResponse = Promise.withResolvers<null>();
    harness.setResponses([
      async () => {
        await firstResponse.promise;
        return fauxAssistantMessage("first answer");
      },
      fauxAssistantMessage("answer after steering"),
    ]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      expect(runtime.isStreaming()).toBeTruthy();

      const delivery = runtime.sendMessage({
        content: "new steering context",
        customType: "subagent-message",
        details: { communicationId: "message-1" },
      });
      firstResponse.resolve(null);

      await delivery.accepted;
      await expect(turn.settled).resolves.toMatchObject({
        text: "answer after steering",
      });
      expect(
        JSON.stringify(
          harness.lastProviderPayload(Type.Object({}, { additionalProperties: true })),
        ),
      ).toContain("new steering context");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("rejects restoring a transcript for another child", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    const { sessionFile } = runtime;
    await runtime.dispose();
    try {
      await expect(
        createChildRuntime({
          ...runtimeRequest(harness, "/root/sibling"),
          sessionFile,
        }),
      ).rejects.toThrow("belongs to a different agent");
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a symlinked child-session directory", async () => {
    const harness = await createAgentSessionHarness();
    const target = await mkdtemp(path.join(os.tmpdir(), "subagents-sessions-"));
    const dataDir = path.join(harness.agentDir, "data", "subagents");
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    try {
      await mkdir(dataDir, { recursive: true });
      await symlink(target, path.join(dataDir, "sessions"));

      await expect(createChildRuntime({ ...runtimeRequest(harness), dataDir })).rejects.toThrow(
        "must be a regular directory",
      );
    } finally {
      await rm(target, { force: true, recursive: true });
      harness.cleanup();
    }
  });
});
