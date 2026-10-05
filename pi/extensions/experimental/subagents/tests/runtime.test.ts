import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { cloneModelRuntime, finalFromMessages, isSubagentHostExtensionPath } from "../runtime.js";

/** A complete assistant message with the given content and stop details. */
const assistant = (
  content: AssistantMessage["content"],
  details: Partial<Pick<AssistantMessage, "endTurn" | "errorMessage" | "stopReason">> = {},
): AssistantMessage => ({ ...fauxAssistantMessage(""), content, ...details });

const text = (value: string) => [{ text: value, type: "text" as const }];

describe("child runtime results", () => {
  it.each([
    { content: [] },
    { content: [{ thinking: "reasoning only", type: "thinking" as const }] },
    { content: text(" \n\t") },
  ])("omits empty assistant text for content %#", ({ content }) => {
    expect(finalFromMessages([assistant(content)], false)).toStrictEqual({ status: "completed" });
  });

  it("preserves nonempty text from the final assistant message", () => {
    expect(finalFromMessages([assistant(text("  finished  "))], false)).toStrictEqual({
      status: "completed",
      text: "  finished  ",
    });
  });

  it.each([
    {
      message: assistant(text("partial"), { errorMessage: "provider failed", stopReason: "error" }),
      outcome: { error: "provider failed", status: "errored" },
    },
    // An abort nobody requested, such as a child extension's, fails the turn.
    {
      message: assistant(text("partial"), { stopReason: "aborted" }),
      outcome: { error: "Turn was aborted", status: "errored" },
    },
  ])("reports an uncancelled $message.stopReason response as errored", ({ message, outcome }) => {
    expect({
      cancelled: finalFromMessages([message], true),
      running: finalFromMessages([message], false),
    }).toStrictEqual({ cancelled: { status: "interrupted" }, running: outcome });
  });

  it("reports a cancelled overflow response as interrupted", () => {
    const message = assistant(text("partial"), { stopReason: "length" });

    expect({
      cancelled: finalFromMessages([message], true),
      cancelledWithoutAssistant: finalFromMessages([], true),
      running: finalFromMessages([message], false),
      runningWithoutAssistant: finalFromMessages([], false),
    }).toStrictEqual({
      cancelled: { status: "interrupted" },
      cancelledWithoutAssistant: { status: "interrupted" },
      running: { status: "completed", text: "partial" },
      runningWithoutAssistant: { status: "completed" },
    });
  });

  it("reports cancellation of an explicitly unfinished response without discarding a completed answer", () => {
    expect(finalFromMessages([assistant(text("answer"), { endTurn: false })], true)).toEqual({
      status: "interrupted",
    });
    expect(finalFromMessages([assistant(text("answer"), { endTurn: true })], true)).toEqual({
      status: "completed",
      text: "answer",
    });
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
