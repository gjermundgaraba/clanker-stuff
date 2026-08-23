/* oxlint-disable eslint/class-methods-use-this -- process manager test double delegates to shared spies */
import { rm } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createCodexDirectTools,
  truncateCodexOutput,
} from "../tools/direct.js";
import { ProcessOutput } from "../tools/process-output.js";
import type { ProcessManager, ProcessResult } from "../tools/process.js";

const processManager = vi.hoisted(() => ({
  construct: vi.fn<() => void>(),
  continue: vi.fn<(options: unknown) => Promise<ProcessResult>>(async () => ({
    durationMs: 0,
    exitCode: 0,
    output: "continued",
    running: false,
    status: "exited",
  })),
  dispose: vi.fn<() => Promise<void>>(async () => await Promise.resolve()),
  start: vi.fn<(options: unknown) => Promise<ProcessResult>>(async () => ({
    durationMs: 0,
    exitCode: 0,
    output: "started",
    running: false,
    status: "exited",
  })),
}));

vi.mock(import("../tools/process.js"), () => {
  const mocked = {
    ProcessManager: class {
      constructor() {
        processManager.construct();
      }

      continue = (options: unknown) => processManager.continue(options);

      dispose = () => processManager.dispose();

      start = (options: unknown) => processManager.start(options);
    },
  };
  return mocked as unknown as {
    ProcessManager: new () => ProcessManager;
  };
});

describe("Codex direct tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries process manager construction after failure", async () => {
    processManager.construct.mockImplementationOnce(() => {
      throw new Error("load failed");
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });

    await expect(
      host.runTool("exec_command", { cmd: "echo first" })
    ).rejects.toThrow("load failed");
    await expect(
      host.runTool("exec_command", { cmd: "echo second" })
    ).resolves.toMatchObject({
      content: [
        { text: "started\n\nProcess exited with code 0.", type: "text" },
      ],
    });
    await direct?.dispose();

    expect(processManager.construct).toHaveBeenCalledTimes(2);
    expect(processManager.start).toHaveBeenCalledOnce();
    expect(processManager.dispose).toHaveBeenCalledOnce();
  });

  it("exposes and enforces per-call output budgets and Codex poll defaults", async () => {
    processManager.start.mockResolvedValueOnce({
      durationMs: 0,
      exitCode: 0,
      output: "abcdefghijklmnop",
      running: false,
      status: "exited",
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });
    const result = await host.runTool("exec_command", {
      cmd: "printf output",
      max_output_tokens: 2,
    });
    processManager.continue.mockResolvedValueOnce({
      durationMs: 0,
      exitCode: 0,
      output: "abcdefgh",
      running: false,
      status: "exited",
    });
    const continued = await host.runTool("write_stdin", {
      max_output_tokens: 0,
      session_id: 1,
    });
    await direct?.dispose();

    expect(result.content).toStrictEqual([
      {
        text: [
          "Warning: truncated output (original token count: 4)",
          "Total output lines: 1",
          "",
          "abcd…2 tokens truncated…mnop",
          "",
          "Process exited with code 0.",
        ].join("\n"),
        type: "text",
      },
    ]);
    expect(result.details).toMatchObject({
      requestedBudgetTruncation: {
        originalTokenCount: 4,
        totalBytes: 16,
        truncatedBy: "tokens",
      },
    });
    expect(
      (
        result.details as {
          requestedBudgetTruncation?: Record<string, unknown>;
        }
      ).requestedBudgetTruncation
    ).not.toHaveProperty("content");
    expect(continued.content).toStrictEqual([
      {
        text: [
          "Warning: truncated output (original token count: 2)",
          "Total output lines: 1",
          "",
          "…2 tokens truncated…",
          "",
          "Process exited with code 0.",
        ].join("\n"),
        type: "text",
      },
    ]);
    expect(processManager.continue).toHaveBeenCalledWith(
      expect.objectContaining({ yieldMs: 5000 })
    );
  });

  it("formats a large raw process result from its full head and tail", async () => {
    const output = new ProcessOutput();
    const rawOutput = Buffer.concat([
      Buffer.from("HEAD\n"),
      Buffer.alloc(60_000, 0xff),
      Buffer.from("\nTAIL"),
    ]);
    output.append(rawOutput);
    const snapshot = await output.snapshot();
    const { fullOutputPath } = snapshot;
    if (fullOutputPath === undefined) {
      throw new Error("Expected preserved process output");
    }
    processManager.start.mockResolvedValueOnce({
      durationMs: 0,
      exitCode: 0,
      fullOutputPath,
      output: snapshot.content,
      running: false,
      status: "exited",
      truncation: snapshot.truncation,
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });
    try {
      const result = await host.runTool("exec_command", {
        cmd: "large output",
        max_output_tokens: 4,
      });
      const text =
        result.content[0]?.type === "text" ? result.content[0].text : "";

      expect(text).toContain("HEAD");
      expect(text).toContain("TAIL");
      expect(text).toContain("Total output lines: 3");
      expect(result.details).toMatchObject({
        requestedBudgetTruncation: { totalBytes: rawOutput.length },
      });
    } finally {
      await direct?.dispose();
      await rm(fullOutputPath, { force: true });
    }
  });

  it.each([
    { expectedTokens: 15_000, fill: 0xff, rawBytes: 20_000 },
    { expectedTokens: 15_001, fill: 0xff, rawBytes: 20_001 },
    {
      expectedTokens: 15_001,
      fill: 0x80,
      rawBytes: 20_001,
    },
  ])(
    "budgets $rawBytes lossy UTF-8 bytes filled with $fill after decoding",
    async ({ expectedTokens, fill, rawBytes }) => {
      const output = new ProcessOutput();
      const rawOutput = Buffer.alloc(rawBytes, fill);
      output.append(rawOutput);
      const snapshot = await output.snapshot();
      const { fullOutputPath } = snapshot;
      if (fullOutputPath === undefined) {
        throw new Error("Expected preserved process output");
      }
      processManager.start.mockResolvedValueOnce({
        durationMs: 0,
        exitCode: 0,
        fullOutputPath,
        output: snapshot.content,
        running: false,
        status: "exited",
        truncation: snapshot.truncation,
      });
      let direct: ReturnType<typeof createCodexDirectTools> | undefined;
      const host = createExtensionHost((pi) => {
        direct = createCodexDirectTools();
        for (const definition of direct.definitions) {
          pi.registerTool(definition);
        }
      });
      try {
        const result = await host.runTool("exec_command", {
          cmd: "invalid utf8",
          max_output_tokens: 5000,
        });

        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining(
            `Warning: truncated output (original token count: ${expectedTokens})`
          ),
        });
        const [content] = result.content;
        const text = content?.type === "text" ? content.text : "";
        const marker = `…${expectedTokens - 5000} tokens truncated…`;
        const [prefix, suffix] = text.split(marker);
        expect(prefix).toMatch(/\uFFFD$/u);
        expect(suffix).toMatch(/^\uFFFD/u);
        expect(result.details).toMatchObject({
          requestedBudgetTruncation: {
            originalTokenCount: expectedTokens,
            totalBytes: rawOutput.length,
          },
        });
      } finally {
        await direct?.dispose();
        await rm(fullOutputPath, { force: true });
      }
    }
  );

  it("caps raw output by model policy without hiding process control metadata", async () => {
    processManager.start.mockResolvedValueOnce({
      durationMs: 1,
      exitCode: null,
      output: "abcdefgh",
      running: true,
      sessionId: 42,
      status: "running",
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });
    const ctx = host.createContext({
      model: {
        ...host.createContext().model,
        api: "openai-codex-responses",
        codexOutputTokenLimit: 0,
        id: "gpt-5.6-sol",
        provider: "openai-codex",
      } as never,
    });

    const result = await host.runTool(
      "exec_command",
      { cmd: "long output", max_output_tokens: 1_000_000 },
      ctx
    );
    await direct?.dispose();

    expect(result.content).toStrictEqual([
      {
        text: [
          "Warning: truncated output (original token count: 2)",
          "Total output lines: 1",
          "",
          "…2 tokens truncated…",
          "",
          "Process is still running.",
          "",
          "Session ID: 42",
        ].join("\n"),
        type: "text",
      },
    ]);
    expect(result.details).toMatchObject({
      effectiveMaxOutputTokens: 0,
      requestedMaxOutputTokens: 1_000_000,
      sessionId: 42,
    });
    expect(result.details).not.toHaveProperty("codeModeResult");
  });

  it("resolves output policy from the current model registry entry", async () => {
    processManager.start.mockResolvedValueOnce({
      durationMs: 0,
      exitCode: 0,
      output: "abcdefgh",
      running: false,
      status: "exited",
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.definitions) {
        pi.registerTool(definition);
      }
    });
    const staleModel = {
      ...host.createContext().model,
      api: "openai-codex-responses",
      codexOutputTokenLimit: 100,
      id: "gpt-5.6-sol",
      provider: "openai-codex",
    };
    const find = vi.fn<
      (provider: string, modelId: string) => typeof staleModel
    >(() => ({
      ...staleModel,
      codexOutputTokenLimit: 0,
    }));
    const ctx = host.createContext({
      model: staleModel as never,
      modelRegistry: { find } as never,
    });

    const result = await host.runTool(
      "exec_command",
      { cmd: "current policy", max_output_tokens: 100 },
      ctx
    );
    await direct?.dispose();

    expect(find).toHaveBeenCalledWith("openai-codex", "gpt-5.6-sol");
    expect(result.details).toMatchObject({ effectiveMaxOutputTokens: 0 });
  });

  it("builds the distinct process result only for nested Code Mode calls", async () => {
    processManager.start.mockResolvedValueOnce({
      durationMs: 1000,
      exitCode: 0,
      output: "abcdefghijklmnop",
      running: false,
      status: "exited",
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.nestedDefinitions) {
        pi.registerTool(definition);
      }
    });
    const ctx = host.createContext({
      model: {
        ...host.createContext().model,
        api: "openai-codex-responses",
        codexOutputTokenLimit: 0,
        id: "gpt-5.6-sol",
        provider: "openai-codex",
      } as never,
    });

    const result = await host.runTool(
      "exec_command",
      { cmd: "long output", max_output_tokens: 2 },
      ctx
    );
    await direct?.dispose();

    expect(result.details).toMatchObject({
      codeModeResult: {
        exit_code: 0,
        original_token_count: 4,
        output: [
          "Warning: truncated output (original token count: 4)",
          "Total output lines: 1",
          "",
          "abcd…2 tokens truncated…mnop",
        ].join("\n"),
        wall_time_seconds: 1,
      },
      effectiveMaxOutputTokens: 0,
    });
  });

  it("preserves the Code Mode output window when no limit is requested", async () => {
    const output = new ProcessOutput();
    const rawOutput = Buffer.concat([
      Buffer.from("HEAD"),
      Buffer.alloc(1024 * 1024 + 100, "x"),
      Buffer.from("TAIL"),
    ]);
    output.append(rawOutput);
    const snapshot = await output.snapshot();
    const { fullOutputPath } = snapshot;
    if (fullOutputPath === undefined) {
      throw new Error("Expected preserved process output");
    }
    processManager.start.mockResolvedValueOnce({
      durationMs: 0,
      exitCode: 0,
      fullOutputPath,
      output: snapshot.content,
      running: false,
      status: "exited",
      truncation: snapshot.truncation,
    });
    let direct: ReturnType<typeof createCodexDirectTools> | undefined;
    const host = createExtensionHost((pi) => {
      direct = createCodexDirectTools();
      for (const definition of direct.nestedDefinitions) {
        pi.registerTool(definition);
      }
    });
    try {
      const result = await host.runTool("exec_command", {
        cmd: "large nested output",
      });
      const codeMode = (
        result.details as {
          codeModeResult?: {
            original_token_count?: number;
            output: string;
          };
        }
      ).codeModeResult;

      expect(codeMode?.output).toContain(
        `Warning: truncated output (original token count: ${Math.ceil(rawOutput.length / 4)})`
      );
      expect(codeMode?.output).toContain("HEAD");
      expect(codeMode?.output).toContain("TAIL");
      expect(codeMode?.original_token_count).toBe(
        Math.ceil(rawOutput.length / 4)
      );
    } finally {
      await direct?.dispose();
      await rm(fullOutputPath, { force: true });
    }
  });

  it("matches Codex UTF-8 middle truncation and line accounting", () => {
    expect(truncateCodexOutput("abc", 0)).toStrictEqual({
      content:
        "Warning: truncated output (original token count: 1)\nTotal output lines: 1\n\n…1 tokens truncated…",
      originalTokenCount: 1,
      truncated: true,
    });
    expect(truncateCodexOutput("éééé", 1)).toStrictEqual({
      content:
        "Warning: truncated output (original token count: 2)\nTotal output lines: 1\n\né…1 tokens truncated…é",
      originalTokenCount: 2,
      truncated: true,
    });
    expect(truncateCodexOutput("a\r\nb\r\n", 1)).toStrictEqual({
      content:
        "Warning: truncated output (original token count: 2)\nTotal output lines: 2\n\na\r…1 tokens truncated…\r\n",
      originalTokenCount: 2,
      truncated: true,
    });
    expect(truncateCodexOutput("abc", 1)).toStrictEqual({
      content: "abc",
      originalTokenCount: 1,
      truncated: false,
    });
  });
});
