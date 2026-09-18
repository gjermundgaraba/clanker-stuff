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
  runtimeResponseFromValue,
  toWireToolDefinition,
} from "../code-mode/protocol.js";
import { CodeModeRuntime, toNestedTool, toPiContent } from "../code-mode/tools.js";
import { sanitizeTraceInput } from "../code-mode/trace-values.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel, wireRecord } from "./fixtures.js";
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
  it("keeps wait timing in UI details without changing the model-facing contract", async () => {
    const stub = createHostClientStub();
    vi.spyOn(stub.client, "wait").mockResolvedValue({
      cellId: "557",
      kind: "yielded",
      contentItems: [],
      elapsedMs: 23_000,
    });
    const runtime = new CodeModeRuntime({ createClient: async () => stub.client });
    const wait = runtime.createTools().find((tool) => tool.name === "wait");

    if (!wait) throw new Error("wait tool is missing");
    expect(wait.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        cell_id: { type: "string" },
        max_tokens: { type: "integer" },
        terminate: { type: "boolean" },
        yield_time_ms: { type: "integer" },
      },
    });
    expect(Value.Check(wait.parameters, { cell_id: "557", elapsedMs: 23_000 })).toBe(false);

    const result = await wait.execute(
      "wait-1",
      { cell_id: "557" },
      undefined,
      undefined,
      TEST_EXTENSION_CONTEXT,
    );

    expect(result.content).toEqual([
      { type: "text", text: 'Still running. Call wait({ cell_id: "557" })' },
    ]);
    expect(result.details).toMatchObject({ cellId: "557", elapsedMs: 23_000, status: "yielded" });
    await runtime.shutdown();
  });

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
      output_schema: {
        additionalProperties: false,
        required: ["agent_id", "nickname"],
      },
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

  it("does not start a client for an already-aborted caller", async () => {
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

  it("observes startup failures after a caller aborts", async () => {
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
        // Drop the Code Mode shell: blank padding rows and one column of side padding.
        .map((line) => line.trimEnd().replace(/^ /u, ""))
        .filter((line) => line.length > 0)
        .join("\n");

    // Once a result exists, its slot owns the header as well as the status.
    expect(render({ status: "running" })).toBe("Exec …\n● running");
    expect(render({ status: "yielded" })).toBe("Exec …\n◌ running");
    expect(render({ status: "result" })).toBe("Exec …\n✓ completed");
    expect(render({ status: "terminated" })).toBe("Exec …\n■ terminated");
    expect(render({ scriptError: "boom", status: "result" })).toMatch(/^Exec …\n✗ error\s+boom$/u);
    expect(render({}, true)).toMatch(/✗ error\s+Host failed/u);
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

  it.each([
    { label: "an optional input", parameters: Type.Object({ code: Type.Optional(Type.String()) }) },
    { label: "a non-string input", parameters: Type.Object({ code: Type.Number() }) },
    {
      label: "multiple required inputs",
      parameters: Type.Object({ code: Type.String(), extra: Type.String() }),
    },
    {
      label: "an additional optional input",
      parameters: Type.Object({ code: Type.String(), extra: Type.Optional(Type.String()) }),
    },
  ])("rejects freeform tools with $label", ({ parameters }) => {
    expect(() =>
      toNestedTool({
        definition: {
          constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } },
          description: "test",
          execute: async () => ({ content: [], details: {} }),
          label: "Test",
          name: "test",
          parameters,
        },
      }),
    ).toThrow(/[Gg]rammar/);
  });

  it.each([{}, { openai_lark: "" }, { openai_lark: " \n\t" }, { openai_regex: "" }])(
    "rejects freeform tools without a nonempty supported grammar: %j",
    (variants) => {
      expect(() =>
        toNestedTool({
          definition: {
            constrainedSampling: { type: "grammar", variants },
            description: "test",
            execute: async () => ({ content: [], details: {} }),
            label: "Test",
            name: "test",
            parameters: Type.Object({ code: Type.String() }),
          },
        }),
      ).toThrow("no supported grammar variant was provided");
    },
  );

  it("accepts a supported regex grammar for freeform calls", () => {
    const nested = toNestedTool({
      definition: {
        constrainedSampling: { type: "grammar", variants: { openai_regex: ".+" } },
        description: "test",
        execute: async () => ({ content: [], details: {} }),
        label: "Test",
        name: "test",
        parameters: Type.Object({ code: Type.String() }),
      },
    });

    expect(toWireToolDefinition(nested)).toMatchObject({ input_schema: null, kind: "freeform" });
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

  it.each(["5", true, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid exec yield time %j without coercion",
    (yieldTime) => {
      const source = `// @exec: ${JSON.stringify({ yield_time_ms: yieldTime })}\ntext("ok")`;
      expect(() => parseExecSource(source)).toThrow("yield_time_ms must be a safe integer");
    },
  );

  it("preserves exec pragma defaults and field-specific bounds", () => {
    expect(parseExecSource('// @exec: {}\ntext("ok")')).toStrictEqual({
      code: 'text("ok")',
      maxOutputTokens: null,
      yieldTimeMs: null,
    });
    expect(() => parseExecSource('// @exec: {"max_output_tokens": 0}\ntext("ok")')).toThrow(
      "max_output_tokens must be a safe integer from 1 to 100000",
    );
    expect(() => parseExecSource('// @exec: {"yield_time_ms": 1e400}\ntext("ok")')).toThrow();
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
                code_mode_host_duration_ns: 1_000,
                content_items: [{ type: "input_text", text: "42" }],
                error_text: errorText,
              },
            },
          },
          type: "execute/initialResponse",
        }),
      );

      if (message.type !== "execute/initialResponse" || message.result.status !== "ok") {
        throw new Error("Expected a successful host reply");
      }

      expect(runtimeResponseFromValue(message.result.value)).toStrictEqual({
        cellId: "1",
        contentItems: [{ type: "input_text", text: "42" }],
        ...(errorText != null ? { errorText } : {}),
        kind: "result",
      });
    },
  );

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

  it("contains hostile object getters, array accessors, and revoked proxies", () => {
    const hostileGetter = {
      get value() {
        throw new Error("hostile getter");
      },
    };

    const hostileArray = new Proxy([1], {
      get: () => {
        throw new Error("hostile array accessor");
      },
    });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const value of [hostileGetter, hostileArray, revoked.proxy]) {
      expect(sanitizeTraceInput(value, 100)).toBe("[unavailable object]");
    }
  });

  it.each([NaN, Infinity, -Infinity])("normalizes non-finite %s to JSON null", (value) => {
    expect(sanitizeTraceInput(value, 100)).toBeNull();
  });

  it("uses detached JSON semantics for diagnostic snapshots", () => {
    expect(sanitizeTraceInput([null, undefined, true, -0, 1.5], 100)).toStrictEqual([
      null,
      null,
      true,
      0,
      1.5,
    ]);
    expect(sanitizeTraceInput({ absent: undefined, big: 1n }, 100)).toStrictEqual({});
    expect(sanitizeTraceInput([1n, Symbol("test")], 100)).toStrictEqual([null, null]);
    expect(sanitizeTraceInput(new Date("2026-01-01"), 100)).toBe("2026-01-01T00:00:00.000Z");
    expect(sanitizeTraceInput(new Date(NaN), 100)).toBeNull();
    const input = { path: "file.ts", nested: { count: 1 } };
    const snapshot = sanitizeTraceInput(input, 1000);
    input.nested.count = 2;
    expect(snapshot).toStrictEqual({ path: "file.ts", nested: { count: 1 } });
    const shared = { count: 1 };
    expect(sanitizeTraceInput([shared, shared], 100)).toStrictEqual([shared, shared]);
    const circular: unknown[] = [];
    circular.push(circular);
    expect(sanitizeTraceInput(circular, 100)).toStrictEqual(["[circular]"]);
  });

  it("preserves complete strings and structures that fit the serialized budget", () => {
    const command = "x".repeat(9000);
    expect(sanitizeTraceInput(command, 16384)).toBe(command);
    expect(sanitizeTraceInput({ cmd: command }, 16384)).toEqual({ cmd: command });

    for (const value of [
      command,
      { cmd: command },
      ["a", "b", "c", "d"],
      { nested: { 'escaped"key': "\u0000\n".repeat(50) } },
      { empty: "" },
    ]) {
      expect(sanitizeTraceInput(value, JSON.stringify(value).length)).toEqual(value);
    }

    expect(sanitizeTraceInput({ ignored: undefined, value: "a" }, 13)).toEqual({ value: "a" });
  });

  it("retains near-budget commands instead of discarding their objects", () => {
    for (const input of [
      { cmd: "x".repeat(16376) },
      { cmd: "x".repeat(16000), n: Array.from({ length: 34 }, () => 1234567890) },
      { cmd: "x".repeat(100_000) },
    ]) {
      const result = sanitizeTraceInput(input, 16384);
      expect(result).toHaveProperty("cmd", expect.stringMatching(/\[value truncated\]$/));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(16384);
    }
  });

  it("shortens multiple strings deterministically without retry exhaustion", () => {
    const input = {
      first: "a".repeat(100),
      second: "b".repeat(100),
      third: "c".repeat(100),
      kind: "patch",
    };

    const result = sanitizeTraceInput(input, 110);
    expect(result).toEqual(sanitizeTraceInput(input, 110));
    expect(result).toMatchObject({
      first: "[value truncated]",
      second: "[value truncated]",
      kind: "patch",
    });
    expect(result).toHaveProperty("third", expect.stringMatching(/\[value truncated\]$/));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(110);

    // The allocation guard clips bodies rather than rejecting the whole value.
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [index, "x".repeat(100_000)]),
    );

    const snapshot = sanitizeTraceInput(many, 16384);
    expect(snapshot).not.toBe("[value limit]");
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(16384);
  });

  it("accounts for escaping and never splits surrogate pairs while shortening", () => {
    for (const text of ["😀".repeat(100), "\u0000".repeat(100), '"\\'.repeat(100)]) {
      for (const budget of [29, 30, 31, 100]) {
        const result = sanitizeTraceInput(text, budget);
        /* oxlint-disable anti-slop/no-runtime-typeof -- Assert the serializer preserved a string before inspecting its truncation marker; accepting another JSON variant would mask a regression. */
        expect(typeof result).toBe("string");

        if (typeof result !== "string") throw new Error("Expected a string snapshot");
        /* oxlint-enable anti-slop/no-runtime-typeof */

        expect(result.endsWith("[value truncated]")).toBe(true);
        expect(result.isWellFormed()).toBe(true);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("evaluates arbitrary hooks only once even when a snapshot needs reduction", () => {
    let projections = 0;
    let reads = 0;

    const input = {
      toJSON() {
        projections += 1;

        return {
          get cmd() {
            reads += 1;

            return "x".repeat(100_000);
          },
        };
      },
    };

    expect(sanitizeTraceInput(input, 100)).toHaveProperty(
      "cmd",
      expect.stringMatching(/\[value truncated\]$/),
    );
    expect(projections).toBe(1);
    expect(reads).toBe(1);
  });

  it("marks cut strings and falls back for exhausted whole-value budgets", () => {
    expect(sanitizeTraceInput("text", 0)).toBe("[value limit]");
    expect(sanitizeTraceInput("a".repeat(100), 30)).toBe("a".repeat(11) + "[value truncated]");
    expect(sanitizeTraceInput([1, 2], 2)).toBe("[value limit]");
    expect(sanitizeTraceInput({ first: 1, second: 2 }, 2)).toBe("[value limit]");
    expect(
      sanitizeTraceInput(
        Array.from({ length: 4097 }, () => null),
        100_000,
      ),
    ).toBe("[value limit]");
    expect(sanitizeTraceInput({ ["k".repeat(1000)]: 1 }, 100)).toBe("[value limit]");
    expect(sanitizeTraceInput("\u0000".repeat(1000), 100)).toBe(
      "\u0000".repeat(13) + "[value truncated]",
    );
    const input = { patch: "*** Begin Patch\n" + "x".repeat(1000) };
    const result = sanitizeTraceInput(input, 100);
    expect(Object.keys(wireRecord(result))).toEqual(["patch"]);
    expect(result).toHaveProperty("patch", expect.stringMatching(/\[value truncated\]$/));
  });

  it("bounds depth and stops visiting siblings on node exhaustion", () => {
    let deep: unknown[] = [];

    for (let i = 0; i < 13; i += 1) deep = [deep];
    expect(JSON.stringify(sanitizeTraceInput(deep, 1000))).toContain("[Array]");
    let visits = 0;

    const leaf = {
      get value() {
        visits += 1;

        return null;
      },
    };

    const input = Array.from({ length: 4096 }, () => leaf);
    expect(sanitizeTraceInput(input, 100_000)).toBe("[value limit]");
    expect(visits).toBeLessThanOrEqual(2048);
  });

  it("contains nested failures and explicitly honors toJSON", () => {
    expect(
      sanitizeTraceInput(
        {
          good: 1,
          bad: {
            get value() {
              throw new Error("hostile");
            },
          },
        },
        100,
      ),
    ).toBe("[unavailable object]");
    expect(sanitizeTraceInput({ toJSON: () => ({ value: "projected" }) }, 100)).toStrictEqual({
      value: "projected",
    });
    expect(
      sanitizeTraceInput(
        {
          toJSON: () => {
            throw new Error("hostile");
          },
        },
        100,
      ),
    ).toBe("[unavailable object]");
    let calls = 0;

    const input = {
      toJSON: () => {
        calls += 1;

        return null;
      },
    };

    expect(sanitizeTraceInput(input, 0)).toBe("[value limit]");
    expect(calls).toBe(0);
  });
});
