import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { CodeModeDelegateRuntime } from "../../code-mode/delegate-runtime.js";
import { nestedToolKey } from "../../code-mode/protocol.js";
import { CodeModeTraceStore } from "../../code-mode/trace-store.js";
import type { NestedTool, RuntimeResponse } from "../../code-mode/types.js";

const extensionContext = createExtensionHost(() => {}).createToolContext();

const response = (kind: RuntimeResponse["kind"] = "yielded", cellId = "cell"): RuntimeResponse => ({
  cellId,
  contentItems: [],
  kind,
});

const nestedTool = (invoke: NestedTool["invoke"]): NestedTool => ({
  name: "probe",
  kind: "function",
  usage: "probe()",
  definition: { name: "probe", description: "Probe", parameters: Type.Object({}) },
  invoke,
});

const invokeMessage = (id: number, cellId = "cell") => ({
  id,
  request: {
    type: "tool/invoke" as const,
    invocation: {
      cell_id: cellId,
      runtime_tool_call_id: `host-${id}`,
      tool_name: { name: "probe", namespace: null },
      input: {},
    },
  },
});

const tools = (tool: NestedTool) => new Map([[nestedToolKey({ name: "probe" }), tool]]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Code Mode active-cell lifecycle", () => {
  it.each(["before", "during"] as const)(
    "retains output until cancellation settles when close arrives %s",
    async (close) => {
      const runtime = new CodeModeDelegateRuntime(() => {});
      const release = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      runtime.bindCell(
        "cell",
        { extensionContext },
        tools(
          nestedTool(async (_input, _ctx, signal) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  aborted.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
            await release.promise;
            throw new Error("cancelled after cleanup");
          }),
        ),
      );
      runtime.handleRequest({
        id: 1,
        request: { type: "notification/send", cellId: "cell", text: "undelivered" },
      });
      runtime.handleRequest(invokeMessage(2));

      if (close === "before") runtime.closeCell("cell");
      let settled = false;

      const finished = runtime.finishResponse(response("terminated")).then((value) => {
        settled = true;

        return value;
      });

      if (close === "during") runtime.closeCell("cell");
      await aborted.promise;
      expect(settled).toBe(false);
      release.resolve();
      const result = await finished;
      expect(result.contentItems).toEqual([{ type: "input_text", text: "undelivered" }]);
      expect(result.traces).toMatchObject([
        { id: "host-2", status: "error", error: "cancelled after cleanup" },
      ]);
      const consumed = await runtime.finishResponse(response("terminated"));
      expect(consumed.contentItems).toEqual([]);
      expect(consumed.traces).toBeUndefined();
      runtime.clear();
    },
  );

  it("cancels and settles only the requested cell", async () => {
    const runtime = new CodeModeDelegateRuntime(() => {});
    const cancelled: string[] = [];
    const completed: string[] = [];
    const release = Promise.withResolvers<void>();

    const tool = nestedTool(async (_input, ctx, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled.push(ctx.cellId);
            resolve();
          },
          { once: true },
        ),
      );
      await release.promise;
      completed.push(ctx.cellId);

      return "cancelled";
    });

    for (const [id, cell] of ["a", "b"].entries()) {
      runtime.bindCell(cell, { extensionContext }, tools(tool));
      runtime.handleRequest(invokeMessage(id, cell));
    }

    const settled = runtime.cancelAndSettle("a");
    expect(cancelled).toEqual(["a"]);
    expect(completed).toEqual([]);
    release.resolve();
    await settled;
    expect(completed).toEqual(["a"]);
    await runtime.cancelAndSettle("b");
    expect(completed).toEqual(["a", "b"]);
    runtime.clear();
  });

  it("uses Pi call IDs and detaches yielded trace snapshots from live updates", async () => {
    const delivered = Promise.withResolvers<void>();
    const send = vi.fn(() => delivered.resolve());
    const update = vi.fn();
    const release = Promise.withResolvers<void>();
    const runtime = new CodeModeDelegateRuntime(send);
    runtime.bindCell(
      "cell",
      { extensionContext, onUpdate: update },
      tools(
        nestedTool(async (_input, ctx) => {
          ctx.captureResult?.({ content: [{ type: "text", text: "first" }] }, "pi-parent/1");
          await release.promise;
          ctx.onUpdate?.({ content: [{ type: "text", text: "second" }], details: undefined });

          return "done";
        }),
      ),
    );
    runtime.handleRequest(invokeMessage(1));
    const yielded = await runtime.finishResponse(response());
    expect(yielded.traces).toMatchObject([
      { id: "pi-parent/1", status: "running", result: { content: [{ text: "first" }] } },
    ]);
    release.resolve();
    await delivered.promise;
    const finished = await runtime.finishResponse(response("result"));
    expect(finished.traces).toMatchObject([
      { id: "pi-parent/1", status: "done", result: { content: [{ text: "second" }] } },
    ]);
    expect(yielded.traces?.[0]?.result?.content).toEqual([{ type: "text", text: "first" }]);
    expect(update.mock.calls.length).toBeGreaterThan(2);
  });

  it("isolates presentation failures and bounds retained notifications", async () => {
    const send = vi.fn();
    const runtime = new CodeModeDelegateRuntime(send);
    runtime.bindCell(
      "cell",
      {
        extensionContext,
        onUpdate: () => {
          throw new Error("display failed");
        },
      },
      new Map(),
    );

    for (let id = 0; id < 102; id++)
      runtime.handleRequest({
        id,
        request: { type: "notification/send", cellId: "cell", text: `${id}:` + "x".repeat(20_000) },
      });
    const result = await runtime.finishResponse(response("result"));
    expect(send).toHaveBeenCalledTimes(102);
    expect(result.contentItems).toHaveLength(100);
    expect(result.contentItems[0]?.text).toMatch(/^2:/u);
    expect(result.contentItems.every((item) => (item.text?.length ?? 0) <= 16_384)).toBe(true);
  });

  it("rejects delegates after closing the cell without invoking tools", async () => {
    const send = vi.fn();
    const invoke = vi.fn<NestedTool["invoke"]>().mockResolvedValue("unused");
    const runtime = new CodeModeDelegateRuntime(send);
    runtime.bindCell("cell", { extensionContext }, tools(nestedTool(invoke)));
    runtime.closeCell("cell");
    runtime.handleRequest(invokeMessage(1));
    await runtime.cancelAndSettle("cell");
    expect(invoke).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { status: "error", message: "Code-mode cell context is unavailable" },
      }),
    );
    await runtime.disposeCell("cell");
  });

  it("rejects duplicate in-flight IDs and clears active delegates on shutdown", async () => {
    const runtime = new CodeModeDelegateRuntime(() => {});
    const aborted = Promise.withResolvers<void>();
    runtime.bindCell(
      "cell",
      { extensionContext },
      tools(
        nestedTool(async (_input, _ctx, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            ),
          );

          return "cancelled";
        }),
      ),
    );
    runtime.handleRequest(invokeMessage(1));
    expect(() => runtime.handleRequest(invokeMessage(1))).toThrow("Duplicate");
    runtime.clear();
    await aborted.promise;
    await runtime.cancelAndSettle("cell");
    expect(runtime.attach(response()).traces).toBeUndefined();
  });

  it("clones normalized snapshots without revisiting hooks or sharing nested data", () => {
    const store = new CodeModeTraceStore();
    store.startCell("cell");
    let projections = 0;
    const details = { nested: { value: 1 } };
    const input = { cmd: "x".repeat(9000), nested: { value: 1 } };
    const trace = store.start("cell", "call", "test", input);
    trace.result = store.captureResult("cell", trace, {
      content: [],
      details: {
        toJSON() {
          projections += 1;

          return details;
        },
      },
    });
    input.nested.value = 2;
    details.nested.value = 2;
    const first = store.snapshot("cell");
    const second = store.snapshot("cell");
    expect(first).toMatchObject({
      traces: [
        {
          input: { cmd: input.cmd, nested: { value: 1 } },
          result: { details: { nested: { value: 1 } } },
        },
      ],
    });
    expect(second.traces).toEqual(first.traces);
    expect(first.traces[0]?.input).not.toBe(second.traces[0]?.input);
    expect(first.traces[0]?.result?.details).not.toBe(second.traces[0]?.result?.details);
    expect(projections).toBe(1);
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

    expect(attached).toMatchObject({ errorText: "boom", droppedTraceCount: 1 });
    expect(attached.elapsedMs).toEqual(expect.any(Number));
    expect(attached.contentItems).toBe(contentItems);
    expect(attached.traces).toHaveLength(50);
    expect(store.snapshot("cell")).toMatchObject({ traces: [], elapsedMs: undefined });
  });
});
