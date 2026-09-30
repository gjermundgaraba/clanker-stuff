import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolLoadout } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme, renderComponent } from "../../../../tests/harness/tui.js";
import { CodeModeHostClient } from "../code-mode/host-client.js";
import {
  RuntimeResponseWireSchema,
  nestedToolKey,
  parseExecSource,
  parseHostMessage,
  runtimeResponseFromValue,
  toWireToolDefinition,
} from "../code-mode/protocol.js";
import { CodeModeRuntime, toNestedTool, toPiContent } from "../code-mode/tools.js";
import type { ToolMetadata } from "../code-mode/types.js";
import type { WireRecord } from "./fixtures.js";

const metadata: ToolMetadata = {
  name: "probe",
  description: "Probe",
  promptGuidelines: ["Call once per operation."],
  parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
};

const TEST_EXTENSION_CONTEXT = createExtensionHost(() => {}).createToolContext();

const executeCode = (runtime: CodeModeRuntime, signal = new AbortController().signal) =>
  runtime
    .createExecTool()
    .execute("call-1", { code: 'text("ok")' }, signal, undefined, TEST_EXTENSION_CONTEXT);

const createHostClientStub = () => {
  const client = new CodeModeHostClient("unused");

  const execute = vi
    .spyOn(client, "execute")
    .mockResolvedValue({ cellId: "cell-1", contentItems: [], kind: "result" });

  const shutdown = vi.spyOn(client, "shutdown").mockResolvedValue();

  return { client, execute, shutdown };
};

const nestedContext = (tool = metadata, result: JsonValue = {}) => {
  const executeTool = vi.fn<ExtensionToolContext["executeTool"]>().mockResolvedValue({
    toolCall: { type: "toolCall", id: "pi-nested-1", name: tool.name, arguments: {} },
    result: {
      content: [{ type: "text", text: "ok" }],
      details: undefined,
      structuredContent: result,
    },
    isError: false,
  });

  const extensionContext = createExtensionHost(() => {}).createToolContext({
    tools: [
      { ...tool, label: tool.name, execute: async () => ({ content: [], details: undefined }) },
    ],
    executeTool,
  });

  return { extensionContext, executeTool, cellId: "cell" };
};

const loadout = (tools: readonly ToolMetadata[]): ToolLoadout => {
  const callable = tools.map((tool) => ({
    ...tool,
    label: tool.name,
    execute: async () => ({ content: [], details: undefined }),
  }));

  return {
    callable,
    declared: callable,
    registered: callable,
    getExposure: () => "direct",
    getNamespace: () => undefined,
  };
};

describe("Codex Code Mode", () => {
  it("exposes only exec and holds its result until completion", async () => {
    const stub = createHostClientStub();
    const completed = Promise.withResolvers<Awaited<ReturnType<CodeModeHostClient["execute"]>>>();
    stub.execute.mockReturnValueOnce(completed.promise);
    const runtime = new CodeModeRuntime({ createClient: async () => stub.client });
    expect(runtime.createTools().map((tool) => tool.name)).toEqual(["exec"]);
    expect(runtime.createExecTool()).toMatchObject({
      exposure: "model-only",
      defaultActive: false,
    });
    let settled = false;

    const execution = executeCode(runtime).then((result) => {
      settled = true;

      return result;
    });

    await vi.waitFor(() => expect(stub.execute).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    completed.resolve({
      cellId: "cell",
      contentItems: [{ type: "input_text", text: "done" }],
      kind: "result",
      elapsedMs: 23_000,
    });
    const result = await execution;
    expect(result.content).toEqual([
      { type: "text", text: "Script completed" },
      { type: "text", text: "done" },
    ]);
    expect(result.details).toMatchObject({ status: "result", elapsedMs: 23_000 });
    await runtime.shutdown();
  });

  it("describes callable tools via prepareLoadout without deactivating them", () => {
    const runtime = new CodeModeRuntime();
    const tool = runtime.createExecTool();
    const prepared = tool.prepareLoadout?.(loadout([metadata]));
    expect(prepared?.descriptions?.exec).toContain("fresh V8 isolate as an async module");
    expect(prepared?.descriptions?.exec).toContain("await tools.probe(input)");
    expect(prepared?.descriptions?.exec).toContain("Call once per operation.");
    expect(prepared?.descriptions?.exec).toContain(JSON.stringify(metadata.parameters));
    expect(prepared?.hiddenDeclarations).toEqual(["probe"]);
    const mixed = runtime.createExecTool(() => false).prepareLoadout?.(loadout([metadata]));
    expect(mixed?.hiddenDeclarations).toEqual([]);
  });

  it("rejects reserved and normalized duplicate names", () => {
    const tool = new CodeModeRuntime().createExecTool();
    expect(() => tool.prepareLoadout?.(loadout([{ ...metadata, name: "exec" }]))).toThrow(
      "reserved",
    );
    expect(() =>
      tool.prepareLoadout?.(
        loadout([
          { ...metadata, name: "a-b" },
          { ...metadata, name: "a_b" },
        ]),
      ),
    ).toThrow("Duplicate");
  });

  it("preserves namespace identity in the wire definition and delegated calls", () => {
    const nested = toNestedTool(
      { ...metadata, name: "spawn_agent", outputSchema: Type.Object({ agent_id: Type.String() }) },
      "pi_subagents",
    );

    expect(toWireToolDefinition(nested)).toMatchObject({
      kind: "function",
      name: "pi_subagents__spawn_agent",
      tool_name: { name: "spawn_agent", namespace: "pi_subagents" },
      output_schema: { type: "object", required: ["agent_id"] },
    });

    const message = parseHostMessage(
      JSON.stringify({
        id: 7,
        request: {
          invocation: {
            cell_id: "cell",
            runtime_tool_call_id: "call",
            tool_name: { name: "search", namespace: "one" },
          },
          type: "tool/invoke",
        },
        type: "delegate/request",
      }),
    );

    expect(message).toMatchObject({
      request: { invocation: { tool_name: { name: "search", namespace: "one" } } },
    });
    expect(nestedToolKey({ name: "search", namespace: "one" })).not.toBe(
      nestedToolKey({ name: "search", namespace: "two" }),
    );
  });

  it("delegates arguments, cancellation, updates and actual call identity to Pi", async () => {
    const ctx = nestedContext();
    const signal = new AbortController().signal;
    const captureResult = vi.fn();
    const onUpdate = vi.fn();

    const oldExecutor = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "bypassed Pi" }],
      details: undefined,
    }));

    const definition = { ...metadata, label: "Probe", execute: oldExecutor };
    const nested = toNestedTool(definition);
    expect(nested.definition).not.toHaveProperty("execute");
    expect(await nested.invoke({ value: 1 }, { ...ctx, captureResult, onUpdate }, signal)).toBe(
      "ok",
    );
    expect(oldExecutor).not.toHaveBeenCalled();
    expect(ctx.executeTool).toHaveBeenCalledOnce();
    expect(ctx.executeTool.mock.calls[0]?.slice(0, 2)).toEqual(["probe", { value: 1 }]);
    const options = ctx.executeTool.mock.calls[0]?.[2];
    expect(options?.signal).toBe(signal);
    expect(typeof options?.onUpdate).toBe("function");
    options?.onUpdate?.({ content: [{ type: "text", text: "progress" }], details: undefined });
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(captureResult).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: "text", text: "ok" }] }),
      "pi-nested-1",
    );
  });

  it("checks current eligibility instead of retaining executable definitions", async () => {
    const ctx = nestedContext();
    const nested = toNestedTool(metadata);
    Object.defineProperty(ctx.extensionContext, "tools", { value: [] });
    await expect(nested.invoke({ value: 1 }, ctx, new AbortController().signal)).rejects.toThrow(
      "no longer available",
    );
    expect(ctx.executeTool).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "text", [], 5])(
    "rejects non-object function arguments %j",
    async (input) => {
      const ctx = nestedContext();
      await expect(
        toNestedTool(metadata).invoke(input, ctx, new AbortController().signal),
      ).rejects.toThrow("Invalid arguments");
      expect(ctx.executeTool).not.toHaveBeenCalled();
    },
  );

  it("returns validated structuredContent rather than private result details", async () => {
    const tool = { ...metadata, outputSchema: Type.Object({ value: Type.Number() }) };
    const ctx = nestedContext(tool, { value: 2 });
    expect(
      await toNestedTool(tool).invoke({ value: 1 }, ctx, new AbortController().signal),
    ).toEqual({ value: 2 });
    const invalid = nestedContext(tool, { value: "wrong" });
    await expect(
      toNestedTool(tool).invoke({ value: 1 }, invalid, new AbortController().signal),
    ).rejects.toThrow("invalid structured content");
  });

  it.each(["error", "terminate", "missing"] as const)(
    "rejects nested %s results",
    async (failure) => {
      const tool = { ...metadata, outputSchema: Type.Object({}) };
      const ctx = nestedContext(tool);
      ctx.executeTool.mockResolvedValueOnce({
        toolCall: { type: "toolCall", id: "nested", name: tool.name, arguments: {} },
        result: {
          content: [{ type: "text", text: "denied" }],
          details: undefined,
          ...(failure === "terminate" ? { terminate: true } : {}),
        },
        isError: failure === "error",
      });
      await expect(
        toNestedTool(tool).invoke({}, ctx, new AbortController().signal),
      ).rejects.toThrow(
        failure === "error"
          ? "denied"
          : failure === "terminate"
            ? "cannot terminate"
            : "no structured content",
      );
    },
  );

  it("converts valid grammar tools to freeform arguments without local execution", async () => {
    const tool: ToolMetadata = {
      name: "patch",
      description: "Patch",
      parameters: Type.Object({ patch: Type.String() }),
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[\\s\\S]+/" } },
    };

    const ctx = nestedContext(tool);
    const nested = toNestedTool(tool);
    expect(nested.kind).toBe("freeform");
    await nested.invoke("source", ctx, new AbortController().signal);
    expect(ctx.executeTool).toHaveBeenCalledWith("patch", { patch: "source" }, expect.any(Object));
  });

  it("renders semantic execution status transitions", () => {
    const renderResult = new CodeModeRuntime().createExecTool().renderResult;

    if (!renderResult) throw new Error("exec renderer is missing");

    const render = (details: WireRecord, isError = false) =>
      renderComponent(
        renderResult(
          { content: [{ type: "text", text: "Host failed" }], details },
          { expanded: false, isPartial: details.status === "running" },
          createIdentityTheme(),
          {
            args: {},
            argsComplete: true,
            cwd: "/tmp",
            executionStarted: true,
            expanded: false,
            invalidate() {},
            isError,
            isPartial: false,
            lastComponent: undefined,
            showImages: false,
            state: {},
            toolCallId: "call-1",
          },
        ),
      )
        ?.split("\n")
        .map((line) => line.trimEnd().replace(/^ /u, ""))
        .filter((line) => line.length > 0)
        .join("\n");

    expect(render({ status: "running" })).toBe("Exec …\n● running");
    expect(render({ status: "result" })).toBe("Exec …\n✓ completed");
    expect(render({ status: "terminated" })).toBe("Exec …\n■ terminated");
    expect(render({ scriptError: "boom", status: "result" })).toMatch(/^Exec …\n✗ error\s+boom$/u);
    expect(render({}, true)).toMatch(/✗ error\s+Host failed/u);
  });

  it.skipIf(process.platform === "win32")(
    "aborts a host startup that never handshakes",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "code-mode-host-"));
      onTestFinished(() => rm(directory, { force: true, recursive: true }));
      const executable = path.join(directory, "host");
      await writeFile(executable, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", "utf-8");
      await chmod(executable, 0o755);
      const client = new CodeModeHostClient(executable);
      const controller = new AbortController();
      const starting = client.start(controller.signal);
      controller.abort();
      await expect(starting).rejects.toMatchObject({ name: "AbortError" });
      await client.shutdown();
    },
  );

  it("closes an in-flight client rather than publishing it after shutdown", async () => {
    const starting = Promise.withResolvers<CodeModeHostClient>();
    const factory = vi.fn(async () => starting.promise);
    const runtime = new CodeModeRuntime({ createClient: factory });
    const execution = executeCode(runtime);
    const stub = createHostClientStub();
    const shutdown = runtime.shutdown();
    starting.resolve(stub.client);
    await shutdown;
    await expect(execution).rejects.toThrow("Code Mode runtime is stopped");
    await expect(executeCode(runtime)).rejects.toThrow("Code Mode runtime is stopped");
    expect(stub.execute).not.toHaveBeenCalled();
    expect(stub.shutdown).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("coalesces startup and preserves shared startup when one caller aborts", async () => {
    const starting = Promise.withResolvers<CodeModeHostClient>();
    let lifetimeSignal: AbortSignal | undefined;

    const factory = vi.fn(async (signal: AbortSignal) => {
      lifetimeSignal = signal;

      return starting.promise;
    });

    const runtime = new CodeModeRuntime({ createClient: factory });
    const controller = new AbortController();
    const first = executeCode(runtime, controller.signal);
    const firstResult = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = executeCode(runtime);
    controller.abort();
    await firstResult;
    expect(lifetimeSignal?.aborted).toBe(false);
    const stub = createHostClientStub();
    starting.resolve(stub.client);
    await second;
    expect(factory).toHaveBeenCalledOnce();
    expect(stub.execute).toHaveBeenCalledOnce();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    expect(stub.shutdown).toHaveBeenCalledOnce();
  });

  it("does not create a client for an already-aborted caller", async () => {
    const stub = createHostClientStub();
    const factory = vi.fn(async () => stub.client);
    const runtime = new CodeModeRuntime({ createClient: factory });
    const controller = new AbortController();
    const reason = new Error("cancelled before startup");
    controller.abort(reason);
    await expect(executeCode(runtime, controller.signal)).rejects.toBe(reason);
    expect(factory).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("observes late startup failure after abort and removes its listener", async () => {
    const starting = Promise.withResolvers<CodeModeHostClient>();
    const runtime = new CodeModeRuntime({ createClient: async () => starting.promise });
    const controller = new AbortController();
    const execution = executeCode(runtime, controller.signal);
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    starting.reject(new Error("late startup failure"));
    await runtime.shutdown();
  });

  it("retries client startup after a startup failure", async () => {
    const stub = createHostClientStub();

    const factory = vi
      .fn<() => Promise<CodeModeHostClient>>()
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValueOnce(stub.client);

    const runtime = new CodeModeRuntime({ createClient: factory });
    await expect(executeCode(runtime)).rejects.toThrow("start failed");
    await executeCode(runtime);
    expect(factory).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });

  it.each(["image/gif", "image/jpeg", "image/png", "image/webp"])(
    "allows %s host images",
    (mimeType) => {
      expect(
        toPiContent({ image_url: `data:${mimeType};base64,AA==`, type: "input_image" }),
      ).toEqual({ data: "AA==", mimeType, type: "image" });
    },
  );
  it("rejects unsupported host image types", () => {
    expect(() =>
      toPiContent({ image_url: "data:image/svg+xml;base64,PHN2Zy8+", type: "input_image" }),
    ).toThrow("Unsupported Code Mode image type");
  });

  it("accepts only the output-budget pragma", () => {
    expect(parseExecSource('// @exec: {"max_output_tokens":20}\ntext("ok")')).toEqual({
      code: 'text("ok")',
      maxOutputTokens: 20,
    });
    expect(parseExecSource('// @exec: {}\ntext("ok")')).toEqual({
      code: 'text("ok")',
      maxOutputTokens: null,
    });
    expect(() => parseExecSource('// @exec: {"yield_time_ms":5}\ntext("ok")')).toThrow();
  });
  it.each(["5", true, null, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, 100_001])(
    "rejects invalid output budget %j",
    (budget) => {
      expect(() =>
        parseExecSource(`// @exec: ${JSON.stringify({ max_output_tokens: budget })}\ntext("ok")`),
      ).toThrow();
    },
  );

  it("rejects ambiguous runtime replies and unsafe message IDs", () => {
    expect(
      Value.Check(RuntimeResponseWireSchema, { Result: { cell_id: "cell" }, Yielded: null }),
    ).toBe(false);
    expect(() =>
      parseHostMessage(
        JSON.stringify({
          id: Number.MAX_SAFE_INTEGER + 1,
          result: { status: "ok", value: null },
          type: "operation/response",
        }),
      ),
    ).toThrow("invalid operation result");
  });
  it.each([null, undefined, "Script failed"])(
    "parses a host result with error_text %s",
    (errorText) => {
      const message = parseHostMessage(
        JSON.stringify({
          id: 2,
          result: {
            status: "ok",
            value: {
              Result: {
                cell_id: "1",
                code_mode_host_duration_ns: 1000,
                content_items: [{ type: "input_text", text: "42" }],
                error_text: errorText,
              },
            },
          },
          type: "execute/initialResponse",
        }),
      );

      if (message.type !== "execute/initialResponse" || message.result.status !== "ok")
        throw new Error("Expected a successful host reply");
      expect(runtimeResponseFromValue(message.result.value)).toEqual({
        cellId: "1",
        contentItems: [{ type: "input_text", text: "42" }],
        ...(errorText != null ? { errorText } : {}),
        kind: "result",
      });
    },
  );
});
