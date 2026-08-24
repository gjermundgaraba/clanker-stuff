import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { cloneModelRuntime, finalFromMessages, isSubagentHostExtensionPath } from "../runtime.js";

describe("child runtime results", () => {
  it.each([
    { content: [] },
    { content: [{ thinking: "reasoning only", type: "thinking" }] },
    { content: [{ text: " \n\t", type: "text" }] },
  ])("omits empty assistant text for content %#", ({ content }) => {
    expect(
      finalFromMessages([
        {
          content,
          role: "assistant",
          stopReason: "stop",
        },
      ]),
    ).toStrictEqual({ status: "completed" });
  });

  it("preserves nonempty text from the final assistant message", () => {
    expect(
      finalFromMessages([
        {
          content: [{ text: "  finished  ", type: "text" }],
          role: "assistant",
          stopReason: "stop",
        },
      ]),
    ).toStrictEqual({ status: "completed", text: "  finished  " });
  });

  it.each([
    {
      message: {
        content: [{ text: "partial", type: "text" }],
        errorMessage: "provider failed",
        role: "assistant",
        stopReason: "error",
      },
      outcome: { error: "provider failed", status: "errored" },
    },
    {
      message: {
        content: [{ text: "partial", type: "text" }],
        role: "assistant",
        stopReason: "aborted",
      },
      outcome: { status: "interrupted" },
    },
  ])("returns a distinct $outcome.status outcome", ({ message, outcome }) => {
    expect(finalFromMessages([message])).toStrictEqual(outcome);
  });

  it("recognizes the host extension through a symlinked install path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "subagents-link-"));
    const linked = path.join(directory, "subagents.ts");
    try {
      await symlink(path.resolve(import.meta.dirname, "../index.ts"), linked);
      expect(isSubagentHostExtensionPath(linked)).toBeTruthy();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("child model runtime", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("keeps usable credentials when another provider lookup fails", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "subagents-runtime-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const source = {
      getAll: () =>
        ["broken", "openai"].map((provider) =>
          fauxProvider({ models: [{ id: "model" }], provider }).getModel(),
        ),
      getApiKeyForProvider: (provider: string) =>
        provider === "broken"
          ? Promise.reject(new Error("broken auth"))
          : Promise.resolve("working-key"),
      getProviderAuthStatus: () => ({
        configured: true,
        source: "runtime" as const,
      }),
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredProviderIds: () => [],
    };

    try {
      const runtime = await cloneModelRuntime(source, "openai");
      await expect(runtime.getAuth("openai")).resolves.toMatchObject({
        auth: { apiKey: "working-key" },
      });
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });

  it("fails when the selected provider credential cannot be copied", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "subagents-runtime-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const source = {
      getAll: () => [fauxProvider({ models: [{ id: "model" }], provider: "broken" }).getModel()],
      getApiKeyForProvider: () => Promise.reject(new Error("broken auth")),
      getProviderAuthStatus: () => ({
        configured: true,
        source: "runtime" as const,
      }),
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getRegisteredProviderIds: () => [],
    };

    try {
      await expect(cloneModelRuntime(source, "broken")).rejects.toThrow("broken auth");
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
