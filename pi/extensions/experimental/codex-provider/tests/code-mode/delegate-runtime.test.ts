import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { CodeModeDelegateRuntime } from "../../code-mode/delegate-runtime.js";
import { nestedToolKey } from "../../code-mode/protocol.js";
import { CodeModeTraceStore } from "../../code-mode/trace-store.js";
import { createToolsModel } from "../fixtures.js";
import type {
  NestedTool,
  RuntimeResponse,
  RuntimeToolResult,
  ToolExecutionContext,
} from "../../code-mode/types.js";

const extensionContext = createExtensionHost(() => {}).createContext();
const response = (kind: RuntimeResponse["kind"] = "yielded"): RuntimeResponse => ({
  cellId: "cell",
  contentItems: [],
  kind,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Code Mode wait snapshots", () => {
  it("keeps each cell's originating model and effort across waits", async () => {
    const host = createExtensionHost(() => {});
    const sent = Promise.withResolvers<void>();
    const runtime = new CodeModeDelegateRuntime(() => sent.resolve());
    const contexts: ToolExecutionContext[] = [];
    const tool: NestedTool = {
      name: "probe",
      kind: "function",
      usage: "probe()",
      definition: {
        name: "probe",
        label: "Probe",
        description: "Probe",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      },
      invoke: async (_input, ctx) => {
        contexts.push(ctx);
        return "ok";
      },
    };
    const tools = new Map([[nestedToolKey({ name: "probe" }), tool]]);
    const original = host.createContext({
      model: createToolsModel("gpt-5.6-sol", true),
      thinkingLevel: "low",
    });
    const later = host.createContext({
      model: createToolsModel("gpt-6-astra", true),
      thinkingLevel: "high",
      cwd: "/new-wait-context",
    });
    runtime.bindCell("a", original, tools);
    runtime.bindCell("b", later, tools);
    runtime.bindCell("a", later);
    for (const [index, cell] of ["a", "b"].entries()) {
      runtime.handleRequest({
        id: index + 1,
        request: {
          type: "tool/invoke",
          invocation: {
            cell_id: cell,
            runtime_tool_call_id: cell,
            tool_name: { name: "probe", namespace: null },
            input: {},
          },
        },
      });
    }
    await sent.promise;
    expect(
      contexts.map(({ extensionContext: ctx }) => [ctx.model?.id, ctx.thinkingLevel, ctx.cwd]),
    ).toEqual([
      ["gpt-5.6-sol", "low", "/new-wait-context"],
      ["gpt-6-astra", "high", "/new-wait-context"],
    ]);
    runtime.clear();
  });

  it.each([1, 2])(
    "ending observer %s leaves the other observer and cell context intact",
    (ended) => {
      const runtime = new CodeModeDelegateRuntime(() => {});
      runtime.bindCell("cell", extensionContext);
      runtime.bindCell("other", extensionContext);
      const a = vi.fn();
      const b = vi.fn();
      const other = vi.fn();
      runtime.observe(1, "cell", a);
      runtime.observe(2, "cell", b);
      runtime.observe(3, "other", other);
      const notify = () =>
        runtime.handleRequest({
          id: 10,
          request: { type: "notification/send", cellId: "cell", text: "progress" },
        });
      notify();
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
      expect(other).toHaveBeenCalledOnce();
      runtime.unobserve(ended);
      // A late duplicate cleanup must not restore or remove anybody else's subscription.
      runtime.unobserve(ended);
      notify();
      expect(a).toHaveBeenCalledTimes(ended === 1 ? 2 : 3);
      expect(b).toHaveBeenCalledTimes(ended === 2 ? 2 : 3);
      expect(other).toHaveBeenCalledOnce();
      const remaining = ended === 1 ? b : a;
      runtime.attach(response());
      notify();
      expect(remaining).toHaveBeenCalledTimes(4);
      runtime.unobserve(ended === 1 ? 2 : 1);
      notify();
      expect(remaining).toHaveBeenCalledTimes(4);
      // Notifications remain available to the model even without a live UI subscriber.
      expect(runtime.attach(response()).contentItems).toEqual([
        { type: "input_text", text: "progress" },
        { type: "input_text", text: "progress" },
      ]);
      runtime.clear();
    },
  );

  it("isolates observer failures and mutations and removes subscriptions on shutdown", () => {
    const send = vi.fn();
    const runtime = new CodeModeDelegateRuntime(send);
    runtime.bindCell("cell", extensionContext);
    runtime.observe(1, "cell", (update) => {
      update.content.length = 0;
      throw new Error("UI failed");
    });
    const healthy = vi.fn();
    runtime.observe(2, "cell", healthy);
    runtime.handleRequest({
      id: 10,
      request: { type: "notification/send", cellId: "cell", text: "progress" },
    });
    expect(healthy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "progress" }],
      }),
    );
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: { status: "ok", value: { type: "notification/delivered" } },
      }),
    );
    runtime.clear();
    runtime.bindCell("cell", extensionContext);
    runtime.handleRequest({
      id: 11,
      request: { type: "notification/send", cellId: "cell", text: "new cell" },
    });
    expect(healthy).toHaveBeenCalledTimes(2);
    runtime.clear();
  });

  it("moves live updates to each wait without mutating yielded snapshots", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const sent = Promise.withResolvers<void>();
    const send = vi.fn(() => sent.resolve());
    const runtime = new CodeModeDelegateRuntime(send);
    const original = vi.fn();
    const firstWait = vi.fn();
    const secondWait = vi.fn();
    const finished = Promise.withResolvers<RuntimeToolResult>();
    let invocation: ToolExecutionContext | undefined;
    const tool: NestedTool = {
      name: "test",
      kind: "function",
      usage: "test()",
      definition: {
        name: "test",
        label: "Test",
        description: "Test",
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      },
      invoke: async (_input, context) => {
        invocation = context;
        return await finished.promise;
      },
    };
    runtime.bindCell("cell", extensionContext, new Map([[nestedToolKey({ name: "test" }), tool]]));
    runtime.observe(1, "cell", original);
    original.mockClear();
    runtime.handleRequest({
      id: 1,
      request: {
        type: "tool/invoke",
        invocation: {
          cell_id: "cell",
          runtime_tool_call_id: "nested",
          tool_name: { name: "test", namespace: null },
          input: {},
        },
      },
    });
    expect(original).toHaveBeenCalledOnce();
    now = 10_000;
    const initial = runtime.attach(response());
    runtime.unobserve(1);
    expect(initial).toMatchObject({ elapsedMs: 10_000, traces: [{ status: "running" }] });

    // Output between polls stays in the trace store, not on a completed tool card.
    invocation?.onUpdate?.({
      content: [{ type: "text", text: "between waits" }],
      details: undefined,
    });
    expect(original).toHaveBeenCalledOnce();
    now = 15_000;
    runtime.observe(2, "cell", firstWait);
    expect(firstWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        details: expect.objectContaining({
          elapsedMs: 15_000,
          traces: [
            expect.objectContaining({
              status: "running",
              result: { content: [{ type: "text", text: "between waits" }] },
            }),
          ],
        }),
      }),
    );
    invocation?.onUpdate?.({
      content: [{ type: "text", text: "during wait" }],
      details: undefined,
    });
    expect(firstWait).toHaveBeenCalledTimes(2);
    expect(original).toHaveBeenCalledOnce();
    now = 20_000;
    const first = runtime.attach(response());
    runtime.unobserve(2);
    now = 25_000;
    runtime.observe(3, "cell", secondWait);
    expect(secondWait).toHaveBeenCalledOnce();
    finished.resolve({ content: [{ type: "text", text: "done" }] });
    await sent.promise;
    expect(secondWait).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          elapsedMs: 25_000,
          traces: [expect.objectContaining({ status: "done" })],
        }),
      }),
    );
    expect(firstWait).toHaveBeenCalledTimes(2);
    expect(initial.traces?.[0]).not.toHaveProperty("result");
    expect(first).toMatchObject({ elapsedMs: 20_000, traces: [{ status: "running" }] });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, result: expect.objectContaining({ status: "ok" }) }),
    );
    runtime.attach(response("result"));
    runtime.unobserve(3);
    runtime.clear();
  });

  it.each(["result", "terminated"] as const)(
    "times no-tool cells and cleans up after %s",
    (kind) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const runtime = new CodeModeDelegateRuntime(() => {});
      const onUpdate = vi.fn();
      runtime.bindCell("cell", extensionContext);
      now = 5000;
      expect(runtime.attach(response())).toMatchObject({ elapsedMs: 5000 });
      now = 10_000;
      runtime.observe(1, "cell", onUpdate);
      expect(onUpdate).toHaveBeenCalledWith({
        content: [],
        details: expect.objectContaining({ elapsedMs: 10_000, traces: [] }),
      });
      now = 12_000;
      runtime.closeCell("cell");
      now = 13_000;
      const terminal = runtime.attach(response(kind));
      runtime.unobserve(1);
      expect(terminal.elapsedMs).toBe(12_000);
      expect(vi.getTimerCount()).toBe(0);
      now = 20_000;
      expect(terminal.elapsedMs).toBe(12_000);
      expect(runtime.attach(response()).elapsedMs).toBeUndefined();
      runtime.clear();
    },
  );

  it("cleans up timing on shutdown and abandoned closed cells", () => {
    vi.useFakeTimers();
    const runtime = new CodeModeDelegateRuntime(() => {});
    runtime.bindCell("cell", extensionContext);
    runtime.closeCell("cell");
    vi.advanceTimersByTime(1000);
    expect(runtime.attach(response()).elapsedMs).toBeUndefined();
    runtime.bindCell("cell", extensionContext);
    runtime.clear();
    expect(runtime.attach(response()).elapsedMs).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps UI callback failures outside execution", () => {
    const runtime = new CodeModeDelegateRuntime(() => {});
    runtime.bindCell("cell", extensionContext);
    expect(() =>
      runtime.observe(1, "cell", () => {
        throw new Error("UI unavailable");
      }),
    ).not.toThrow();
    runtime.clear();
  });

  it("attaches timing to script errors without changing output or trace limits", () => {
    const store = new CodeModeTraceStore();
    store.startCell("cell");
    for (let i = 0; i < 51; i++) store.start("cell", String(i), "test", {});
    const contentItems = [{ type: "input_text" as const, text: "output" }];
    const attached = store.attach({
      cellId: "cell",
      kind: "result",
      contentItems,
      errorText: "boom",
    });
    expect(attached).toMatchObject({
      elapsedMs: expect.any(Number),
      errorText: "boom",
      droppedTraceCount: 1,
    });
    expect(attached.contentItems).toBe(contentItems);
    expect(attached.traces).toHaveLength(50);
    expect(store.snapshot("cell")).toMatchObject({ traces: [], elapsedMs: undefined });
  });
});
