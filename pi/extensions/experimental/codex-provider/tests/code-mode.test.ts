import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  toWireToolDefinition,
} from "../code-mode/protocol.js";
import { CodeModeRuntime, toNestedTool, toPiContent } from "../code-mode/tools.js";
import { sanitizeTraceInput } from "../code-mode/trace-values.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "./fixtures.js";
import type { WireRecord } from "./fixtures.js";

const PromptResultSchema = Type.Object({ systemPrompt: Type.String() });
const TEST_EXTENSION_CONTEXT = createExtensionHost(() => {}).createContext();

const executeCode = (runtime: CodeModeRuntime, signal = new AbortController().signal) => {
  const execute = runtime.createTools().find((tool) => tool.name === "exec");
  if (!execute) {
    throw new Error("exec tool is missing");
  }
  return execute.execute(
    "call-1",
    { code: 'text("ok")' },
    signal,
    () => {},
    TEST_EXTENSION_CONTEXT,
  );
};

const createHostClientStub = () => {
  const client = new CodeModeHostClient("unused");
  const execute = vi.spyOn(client, "execute").mockResolvedValue({
    cellId: "cell-1",
    contentItems: [],
    kind: "result",
  });
  const shutdown = vi.spyOn(client, "shutdown").mockResolvedValue();
  return {
    client,
    execute,
    shutdown,
  };
};

describe("Codex code mode", () => {
  it("preserves nested wire identity", () => {
    const nested = toNestedTool({
      definition: {
        description: "test",
        execute: async () => ({ content: [], details: {} }),
        label: "test",
        name: "spawn_agent",
        parameters: Type.Object({}, { additionalProperties: false }),
      },
      namespace: "pi_subagents",
      outputSchema: {
        additionalProperties: false,
        properties: {
          agent_id: { type: "string" },
          nickname: { type: ["string", "null"] },
        },
        required: ["agent_id", "nickname"],
        type: "object",
      },
    });
    expect(toWireToolDefinition(nested)).toMatchObject({
      kind: "function",
      name: "pi_subagents__spawn_agent",
      output_schema: expect.objectContaining({
        additionalProperties: false,
        required: ["agent_id", "nickname"],
      }),
      tool_name: {
        name: "spawn_agent",
        namespace: "pi_subagents",
      },
    });
  });

  it("keeps namespace identity on delegated calls", () => {
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
      request: {
        invocation: {
          tool_name: { name: "search", namespace: "one" },
        },
      },
    });
    expect(nestedToolKey({ name: "search", namespace: "one" })).not.toBe(
      nestedToolKey({ name: "search", namespace: "two" }),
    );
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

  it("closes an in-flight client instead of publishing it after shutdown", async () => {
    const starting = Promise.withResolvers<CodeModeHostClient>();
    const factory = vi.fn<(signal: AbortSignal | undefined) => Promise<CodeModeHostClient>>(
      async () => await starting.promise,
    );
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

  it("coalesces concurrent client startup and shutdown", async () => {
    const shared = createHostClientStub();
    const starting = Promise.withResolvers<CodeModeHostClient>();
    const sharedFactory = vi.fn<(signal: AbortSignal | undefined) => Promise<CodeModeHostClient>>(
      async () => await starting.promise,
    );
    const sharedRuntime = new CodeModeRuntime({
      createClient: sharedFactory,
    });
    const first = executeCode(sharedRuntime);
    const second = executeCode(sharedRuntime);

    starting.resolve(shared.client);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(sharedFactory).toHaveBeenCalledOnce();
    expect(shared.execute).toHaveBeenCalledTimes(2);
    await Promise.all([sharedRuntime.shutdown(), sharedRuntime.shutdown()]);
    expect(shared.shutdown).toHaveBeenCalledOnce();
  });

  it("keeps shared client startup alive when one caller aborts", async () => {
    const starting = Promise.withResolvers<CodeModeHostClient>();
    let lifetimeSignal: AbortSignal | undefined;
    const factory = vi.fn<(signal: AbortSignal) => Promise<CodeModeHostClient>>(async (signal) => {
      lifetimeSignal = signal;
      return await starting.promise;
    });
    const runtime = new CodeModeRuntime({ createClient: factory });
    const controller = new AbortController();
    const first = executeCode(runtime, controller.signal);
    const firstResult = (async (): Promise<Awaited<typeof first> | Error> => {
      try {
        return await first;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    })();
    const second = executeCode(runtime);
    const stub = createHostClientStub();

    controller.abort();
    await expect(firstResult).resolves.toMatchObject({ name: "AbortError" });
    expect(lifetimeSignal?.aborted).toBeFalsy();

    starting.resolve(stub.client);
    await expect(second).resolves.toBeDefined();

    await runtime.shutdown();
    expect({
      execute: stub.execute.mock.calls.length,
      factory: factory.mock.calls.length,
      shutdown: stub.shutdown.mock.calls.length,
    }).toStrictEqual({ execute: 1, factory: 1, shutdown: 1 });
  });

  it("retries client creation after a startup failure", async () => {
    const retry = createHostClientStub();
    const retryFactory = vi
      .fn<() => Promise<CodeModeHostClient>>()
      .mockRejectedValueOnce(new Error("start failed"))
      .mockResolvedValueOnce(retry.client);
    const retryRuntime = new CodeModeRuntime({ createClient: retryFactory });
    await expect(executeCode(retryRuntime)).rejects.toThrow("start failed");
    await expect(executeCode(retryRuntime)).resolves.toBeDefined();
    expect(retryFactory).toHaveBeenCalledTimes(2);
    await retryRuntime.shutdown();
    expect(retry.shutdown).toHaveBeenCalledOnce();
  });

  it("provides native-style runtime and nested tool instructions", () => {
    const runtime = new CodeModeRuntime();
    const definition = {
      description: "Runs a test operation.",
      execute: async () => ({ content: [], details: {} }),
      label: "Test",
      name: "test",
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    };
    runtime.setNestedTools([{ definition }]);
    const tools = runtime.createTools();

    expect(tools.find((tool) => tool.name === "exec")?.description).toContain(
      "fresh V8 isolate as an async module",
    );
    expect(tools.find((tool) => tool.name === "wait")?.description).toContain(
      "returns only new output since the last yield",
    );
    expect(runtime.prompt()).toContain(
      "### `test`\nRuns a test operation.\n\nUsage: `await tools.test(input)`",
    );
    runtime.setNestedTools([
      { definition: { ...definition, name: "exec_command" } },
      { definition: { ...definition, name: "write_stdin" } },
    ]);
    expect(runtime.prompt()).toContain("yield_time_ms?: number, max_output_tokens?: number");
    expect(runtime.prompt()).toContain(
      "chars?: string, yield_time_ms?: number, max_output_tokens?: number",
    );
  });

  it("renders semantic execution status transitions", () => {
    const renderResult = new CodeModeRuntime()
      .createTools()
      .find((tool) => tool.name === "exec")?.renderResult;
    if (!renderResult) {
      throw new Error("exec renderer is missing");
    }

    const render = (details: WireRecord) =>
      renderComponent(
        renderResult(
          { content: [], details },
          { expanded: false, isPartial: details.status === "running" },
          createIdentityTheme(),
          // SAFETY: These trace-free fixtures never invoke a nested renderer, so context is not read.
          {} as never,
        ),
      )?.trimEnd();

    expect(render({ status: "running" })).toBe("● running");
    expect(render({ status: "yielded" })).toBe("◌ yielded");
    expect(render({ status: "result" })).toBe("✓ completed");
    expect(render({ status: "terminated" })).toBe("■ terminated");
    expect(render({ scriptError: "boom", status: "result" })).toBe("✗ error");
  });

  it("adds nested tool instructions only with Code Mode", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
    const ctx = host.createContext({ model });
    await host.emitSessionStart(ctx);
    await host.runCommand("code-mode", "", ctx);

    const [prompt] = await host.emit(
      "before_agent_start",
      {
        prompt: "test",
        systemPrompt: "Base prompt\nCurrent working directory: /tmp",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx,
    );
    expect(prompt).toHaveProperty(
      "systemPrompt",
      expect.stringContaining("Tools available in exec:"),
    );
    const augmentedPrompt = Value.Check(PromptResultSchema, prompt) ? prompt.systemPrompt : "";
    expect(augmentedPrompt).toContain(
      "Current working directory: /tmp\n\nTools available in exec:",
    );
    const [duplicate] = await host.emit(
      "before_agent_start",
      {
        prompt: "test",
        systemPrompt: augmentedPrompt,
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx,
    );
    expect(duplicate).toBeUndefined();
  });

  it("validates nested calls before invoking their definition", async () => {
    const execute = vi.fn<
      (
        id: string,
        params: { value: string },
      ) => Promise<{
        content: { text: string; type: "text" }[];
        details: Record<string, never>;
      }>
    >(async (_id, params) => ({
      content: [{ text: params.value, type: "text" }],
      details: {},
    }));
    const nested = toNestedTool({
      definition: {
        description: "test",
        execute,
        label: "test",
        name: "test",
        parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
      },
    });
    const context = {
      cwd: "/tmp",
      extensionContext: TEST_EXTENSION_CONTEXT,
    };

    await expect(
      nested.invoke({ extra: true, value: "ok" }, context, new AbortController().signal),
    ).rejects.toThrow('Validation failed for tool "test"');
    expect(execute).not.toHaveBeenCalled();

    await expect(
      nested.invoke({ value: "ok" }, context, new AbortController().signal),
    ).resolves.toBe("ok");
  });

  it("returns declared structured nested results as values", async () => {
    const nested = toNestedTool({
      definition: {
        description: "test",
        execute: async () => ({
          content: [
            {
              text: JSON.stringify({ agent_id: "agent-1", nickname: "Scout" }),
              type: "text" as const,
            },
          ],
          details: { hostOnly: true },
        }),
        label: "test",
        name: "spawn_agent",
        parameters: Type.Object({}, { additionalProperties: false }),
      },
      namespace: "pi_subagents",
      outputSchema: { type: "object" },
    });

    await expect(
      nested.invoke({}, { extensionContext: TEST_EXTENSION_CONTEXT }, new AbortController().signal),
    ).resolves.toStrictEqual({
      agent_id: "agent-1",
      nickname: "Scout",
    });
  });

  it("rejects invalid declared structured nested results", async () => {
    const nested = toNestedTool({
      definition: {
        description: "test",
        execute: async () => ({
          content: [{ text: "not json", type: "text" as const }],
          details: {},
        }),
        label: "test",
        name: "spawn_agent",
        parameters: Type.Object({}, { additionalProperties: false }),
      },
      outputSchema: { type: "object" },
    });

    await expect(
      nested.invoke({}, { extensionContext: TEST_EXTENSION_CONTEXT }, new AbortController().signal),
    ).rejects.toThrow("declared structured output but returned invalid JSON");
  });

  it("preserves grammar-constrained tools as freeform nested calls", async () => {
    const execute = vi.fn<
      (
        id: string,
        params: { patch: string },
      ) => Promise<{
        content: { text: string; type: "text" }[];
        details: object;
      }>
    >(async (_id, params) => ({
      content: [{ text: params.patch, type: "text" }],
      details: {},
    }));
    const nested = toNestedTool({
      definition: {
        constrainedSampling: {
          type: "grammar",
          variants: { openai_lark: "start: /.+/" },
        },
        description: "Apply a patch.",
        execute,
        label: "Apply Patch",
        name: "apply_patch",
        parameters: Type.Object({ patch: Type.String() }, { additionalProperties: false }),
      },
    });

    expect(toWireToolDefinition(nested)).toMatchObject({
      input_schema: null,
      kind: "freeform",
    });
    await expect(
      nested.invoke(
        "*** Begin Patch\n*** End Patch",
        { extensionContext: TEST_EXTENSION_CONTEXT },
        new AbortController().signal,
      ),
    ).resolves.toContain("*** Begin Patch");
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      { patch: "*** Begin Patch\n*** End Patch" },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.anything(),
    );
  });

  it("rejects text returned by nested view_image", async () => {
    const nested = toNestedTool({
      definition: {
        description: "test",
        execute: async () => ({
          content: [{ text: "<svg/>", type: "text" as const }],
          details: {},
        }),
        label: "test",
        name: "view_image",
        parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      },
    });

    await expect(
      nested.invoke(
        { path: "/tmp/image.svg" },
        { extensionContext: TEST_EXTENSION_CONTEXT },
        new AbortController().signal,
      ),
    ).rejects.toThrow("convert SVG to PNG first");
  });

  it("rejects unsupported host image types before they reach Pi", () => {
    expect(() =>
      toPiContent({
        image_url: "data:image/svg+xml;base64,PHN2Zy8+",
        type: "input_image",
      }),
    ).toThrow('Unsupported Code Mode image type "image/svg+xml"');
  });

  it.each(["image/gif", "image/jpeg", "image/png", "image/webp"])(
    "allows %s host images",
    (mimeType) => {
      expect(
        toPiContent({
          image_url: `data:${mimeType};base64,AA==`,
          type: "input_image",
        }),
      ).toStrictEqual({ data: "AA==", mimeType, type: "image" });
    },
  );

  it("parses host execution pragmas", () => {
    expect(
      parseExecSource('// @exec: {"yield_time_ms": 5, "max_output_tokens": 20}\ntext("ok")'),
    ).toStrictEqual({
      code: 'text("ok")',
      maxOutputTokens: 20,
      yieldTimeMs: 5,
    });
  });

  it("rejects ambiguous runtime replies and unsafe message IDs", () => {
    expect(
      Value.Check(RuntimeResponseWireSchema, {
        Result: { cell_id: "cell-1" },
        Yielded: null,
      }),
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

  it("contains hostile trace values", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile ownKeys");
        },
      },
    );

    expect(sanitizeTraceInput(hostile, 100)).toBe("[unavailable object]");
  });
});
