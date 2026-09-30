import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { captureExecutionSettings, withExecutionSettings } from "../tools/execution-context.js";

describe("execution settings", () => {
  it("is idempotent without losing fresh context on rebinding", () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createToolContext({ cwd: "/first", thinkingLevel: "low" });
    const settings = captureExecutionSettings(ctx);
    const first = withExecutionSettings(ctx, settings);
    expect(withExecutionSettings(first)).toBe(first);
    expect(withExecutionSettings(first, settings)).toBe(first);
    const fresh = host.createToolContext({ cwd: "/second", thinkingLevel: "high" });
    const rebound = withExecutionSettings(fresh, settings);
    expect(rebound).not.toBe(first);
    expect(rebound.cwd).toBe("/second");
    expect(rebound.thinkingLevel).toBe("low");
    const changed = withExecutionSettings(first, { ...settings, thinkingLevel: "high" });
    expect(changed).not.toBe(first);
    expect(changed.thinkingLevel).toBe("high");
  });

  it("passes wrapped contexts through runTool unchanged, preserving live inherited capabilities", async () => {
    const received = vi.fn();

    const host = createExtensionHost((pi) => {
      pi.registerTool({
        name: "probe",
        label: "Probe",
        description: "Test context identity",
        parameters: Type.Object({}),
        execute: async (_id, _args, _signal, _update, ctx) => {
          received(ctx);
          await ctx.executeTool("nested", { value: 1 });

          return { content: [], details: undefined };
        },
      });
    });

    const executeTool = vi.fn<ReturnType<typeof host.createToolContext>["executeTool"]>(
      async (name) => ({
        toolCall: { type: "toolCall", id: "outer/1", name, arguments: {} },
        result: { content: [], details: undefined },
        isError: false,
      }),
    );

    const tools: ReturnType<typeof host.createToolContext>["tools"] = [];
    const ctx = host.createToolContext({ thinkingLevel: "low", tools, executeTool });
    let cwd = "/first";
    Object.defineProperty(ctx, "cwd", { get: () => cwd });
    const wrapped = withExecutionSettings(ctx);
    expect(Object.getOwnPropertyDescriptor(wrapped, "thinkingLevel")?.enumerable).toBe(false);
    cwd = "/second";
    await host.runTool("probe", {}, { ctx: wrapped });
    expect(received).toHaveBeenCalledExactlyOnceWith(wrapped);
    expect(wrapped.cwd).toBe("/second");
    expect(wrapped.thinkingLevel).toBe("low");
    expect(wrapped.tools).toBe(tools);
    expect(wrapped.executeTool).toBe(executeTool);
    expect(executeTool).toHaveBeenCalledExactlyOnceWith("nested", { value: 1 });
  });
});
