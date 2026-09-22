import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { CodeModeHostClient } from "../../code-mode/host-client.js";
import { CodeModeRuntime } from "../../code-mode/tools.js";
import type { NestedTool, NestedToolContext } from "../../code-mode/types.js";

const usage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ctx = createExtensionHost(() => {}).createContext();

afterEach(() => vi.restoreAllMocks());

it("keeps yielded accounting with its cell, and drains each outer call only once", async () => {
  const client = new CodeModeHostClient("unused");
  const calls = new Map<string, { tool: NestedTool; context: NestedToolContext }>();
  vi.spyOn(client, "shutdown").mockResolvedValue();
  vi.spyOn(client, "execute").mockImplementation(async (cellId, context, _signal, tools) => {
    const tool = tools[0];

    if (!tool) throw new Error("Missing nested tool");
    context.onCellStarted?.(cellId);
    calls.set(cellId, { tool, context: { ...context, cellId } });

    return { cellId, kind: "yielded", contentItems: [] };
  });
  vi.spyOn(client, "wait").mockImplementation(async (cellId) => ({
    cellId,
    kind: "result",
    contentItems: [],
  }));
  vi.spyOn(client, "terminate").mockImplementation(async (cellId) => {
    const call = calls.get(cellId);

    if (!call) throw new Error("Missing cell");
    await call.tool.invoke({}, call.context, new AbortController().signal);

    return { cellId, kind: "terminated", contentItems: [] };
  });
  const runtime = new CodeModeRuntime({ createClient: async () => client });
  runtime.prepareNestedTools([
    {
      definition: {
        name: "sample",
        label: "Sample",
        description: "Sample",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined, usage }),
      },
      resultMode: "content",
    },
  ])();
  const [exec, wait] = runtime.createTools();

  if (!exec || !wait) throw new Error("Missing tools");
  const signal = new AbortController().signal;

  await exec.execute("exec-a", { code: "a" }, signal, undefined, ctx);
  expect(runtime.takeAccounting("exec-a")).toBeUndefined();
  const a = calls.get("a");

  if (!a) throw new Error("Missing cell");
  await a.tool.invoke({}, a.context, signal);

  await exec.execute("exec-b", { code: "b" }, signal, undefined, ctx);
  expect(runtime.takeAccounting("exec-b")).toBeUndefined();
  await wait.execute("wait-b", { cell_id: "b" }, signal, undefined, ctx);
  expect(runtime.takeAccounting("wait-b")).toBeUndefined();

  await wait.execute("terminate-b", { cell_id: "b", terminate: true }, signal, undefined, ctx);
  expect(runtime.takeAccounting("terminate-b")).toMatchObject({ usage, details: { cellId: "b" } });
  expect(runtime.takeAccounting("terminate-b")).toBeUndefined();

  await wait.execute("wait-a", { cell_id: "a" }, signal, undefined, ctx);
  expect(runtime.takeAccounting("wait-a")).toMatchObject({ usage, details: { cellId: "a" } });
  expect(runtime.takeAccounting("wait-a")).toBeUndefined();
  await wait.execute("wait-a-again", { cell_id: "a" }, signal, undefined, ctx);
  expect(runtime.takeAccounting("wait-a-again")).toBeUndefined();
  await runtime.shutdown();
});

it.each(["success", "failure", "cancellation"] as const)(
  "routes returned and failure-safe accounting to the originating outer call on %s",
  async (outcome) => {
    const client = new CodeModeHostClient("unused");
    const controller = new AbortController();
    vi.spyOn(client, "shutdown").mockResolvedValue();
    vi.spyOn(client, "execute").mockImplementation(async (_source, context, signal, tools) => {
      const tool = tools[0];

      if (!tool || !signal) throw new Error("Missing invocation");
      context.onCellStarted?.("cell");
      await tool.invoke({}, { ...context, cellId: "cell" }, signal);

      return { cellId: "cell", kind: "result", contentItems: [] };
    });
    const takeAccounting = vi.fn(() => ({ usage, details: { sampled: true } }));
    const runtime = new CodeModeRuntime({ createClient: async () => client });
    runtime.prepareNestedTools([
      {
        definition: {
          name: "sample",
          label: "Sample",
          description: "Sample",
          parameters: Type.Object({}),
          execute: async () => {
            if (outcome === "cancellation") {
              controller.abort();
              controller.signal.throwIfAborted();
            }

            if (outcome === "failure") throw new Error("Sampling failed");

            return { content: [], details: undefined };
          },
        },
        resultMode: "content",
        takeAccounting,
      },
    ])();

    const execution = runtime
      .createExecTool()
      .execute("outer", { code: "sample" }, controller.signal, undefined, ctx);

    if (outcome === "success") await execution;
    else await expect(execution).rejects.toThrow();
    expect(runtime.takeAccounting("unrelated")).toBeUndefined();
    expect(runtime.takeAccounting("outer")).toMatchObject({
      usage,
      details: { cellId: "cell", entries: [{ details: { sampled: true } }] },
    });
    expect(runtime.takeAccounting("outer")).toBeUndefined();
    expect(takeAccounting).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  },
);
