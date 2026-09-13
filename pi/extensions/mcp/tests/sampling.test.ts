import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { CreateMessageRequestParams } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { sample, sumUsage } from "../sampling.js";
import { setupMcpTest } from "./helpers.js";

const model = fauxProvider().getModel();
const params: CreateMessageRequestParams = {
  maxTokens: 8,
  messages: [{ role: "user", content: { type: "text", text: "hello" } }],
};
const usage = {
  input: 10,
  output: 20,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 33,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

describe("MCP sampling owner", () => {
  const t = setupMcpTest();
  const setup = () => {
    const host = t.createExtensionHost(() => {}, { model });
    const status = { limitReached: false, usageComplete: false, usage };
    const dispose = vi.fn(async () => {});
    const boundText = vi.fn((text: string) => text);
    const scopes = vi.fn();
    host.events.on("clanker-codex:sampling-scope-request", (request) => {
      // SAFETY: The real sampling owner is the only emitter in this isolated host.
      const typed = request as { maxTokens: number; resolve: (scope: Promise<unknown>) => void };
      scopes(typed.maxTokens);
      typed.resolve(
        Promise.resolve({
          run: <T>(run: () => T) => run(),
          boundText,
          dispose,
          status,
        }),
      );
    });
    return { host, status, dispose, scopes, boundText };
  };

  it("preserves server-supplied roles while excluding Pi history and tools", async () => {
    const { host, dispose } = setup();
    let captured: Context | undefined;
    const ctx = host.createContext({
      modelRegistry: {
        complete: async (_model, context) => {
          captured = context;
          return fauxAssistantMessage("answer");
        },
      },
    });
    const report = vi.fn();
    await sample(
      host,
      ctx,
      model,
      {
        ...params,
        systemPrompt: "server system",
        messages: [
          params.messages[0]!,
          { role: "assistant", content: { type: "text", text: "previous answer" } },
        ],
      },
      new AbortController().signal,
      report,
    );
    expect(captured).toMatchObject({
      systemPrompt: "server system",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
          model: model.id,
          provider: model.provider,
        },
      ],
    });
    expect(captured!.tools).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      model: `${model.provider}/${model.id}`,
      usage,
      complete: false,
    });
  });

  it.each([0, -1, 1.5, Infinity, NaN])(
    "rejects invalid budget %s before inference or allocation",
    async (maxTokens) => {
      const { host, scopes } = setup();
      const complete = vi.fn(async () => fauxAssistantMessage("unexpected"));
      const ctx = host.createContext({ modelRegistry: { complete } });
      await expect(
        sample(host, ctx, model, { ...params, maxTokens }, new AbortController().signal, () => {}),
      ).rejects.toThrow("positive safe integer");
      expect(scopes).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("clamps budgets to the selected model and rejects unsupported input before inference", async () => {
    const { host, scopes } = setup();
    const ctx = host.createContext({
      modelRegistry: { complete: async () => fauxAssistantMessage("answer") },
    });
    await sample(
      host,
      ctx,
      model,
      { ...params, maxTokens: model.maxTokens + 100 },
      new AbortController().signal,
      () => {},
    );
    expect(scopes).toHaveBeenCalledWith(model.maxTokens);
    await expect(
      sample(
        host,
        ctx,
        model,
        { ...params, stopSequences: [""] },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("empty");
    await expect(
      sample(
        host,
        ctx,
        model,
        {
          ...params,
          messages: [
            { role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } },
          ],
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("text input only");
    expect(scopes).toHaveBeenCalledOnce();
  });

  it.each(["provider", "conversion", "cancel"])(
    "disposes and preserves incomplete usage after %s failure",
    async (failure) => {
      const { host, dispose } = setup();
      const controller = new AbortController();
      const ctx = host.createContext({
        modelRegistry: {
          complete: async () => {
            if (failure === "provider") throw new Error("provider failed");
            if (failure === "cancel") controller.abort(new Error("user cancelled"));
            return {
              ...fauxAssistantMessage("answer"),
              content: [{ type: "thinking", thinking: "unsupported" }],
            };
          },
        },
      });
      const report = vi.fn();
      await expect(sample(host, ctx, model, params, controller.signal, report)).rejects.toThrow();
      expect(dispose).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith({
        model: `${model.provider}/${model.id}`,
        usage,
        complete: false,
      });
    },
  );

  it("waits for disposal before reporting usage and completing cancellation", async () => {
    const { host, dispose } = setup();
    const gate = Promise.withResolvers<void>();
    dispose.mockImplementation(() => gate.promise);
    const ctx = host.createContext({
      modelRegistry: {
        complete: async () => {
          throw new Error("failed");
        },
      },
    });
    const report = vi.fn();
    const result = sample(host, ctx, model, params, new AbortController().signal, report);
    const rejected = expect(result).rejects.toThrow("failed");
    await expect.poll(() => dispose.mock.calls.length).toBe(1);
    expect(report).not.toHaveBeenCalled();
    gate.resolve();
    await rejected;
    expect(report).toHaveBeenCalledOnce();
  });
  it("rechecks the token bound after applying server stop sequences", async () => {
    const { host, boundText } = setup();
    boundText.mockReturnValue("bounded-prefix");
    const ctx = host.createContext({
      modelRegistry: { complete: async () => fauxAssistantMessage("prefix STOP remainder") },
    });
    const result = await sample(
      host,
      ctx,
      model,
      { ...params, stopSequences: [" STOP"] },
      new AbortController().signal,
      () => {},
    );
    expect(boundText).toHaveBeenCalledWith("prefix");
    expect(result).toMatchObject({
      content: { type: "text", text: "bounded-prefix" },
      stopReason: "maxTokens",
    });
  });

  it("does not turn missing provider accounting into Pi's initialized zero usage", async () => {
    const host = t.createExtensionHost(() => {}, { model });
    host.events.on("clanker-codex:sampling-scope-request", (request) => {
      // SAFETY: The real sample function is the sole emitter in this isolated host.
      const typed = request as { resolve: (scope: Promise<unknown>) => void };
      typed.resolve(
        Promise.resolve({
          run: <T>(run: () => T) => run(),
          boundText: (text: string) => text,
          dispose: async () => {},
          status: { limitReached: true, usageComplete: false },
        }),
      );
    });
    const ctx = host.createContext({
      modelRegistry: { complete: async () => fauxAssistantMessage("bounded") },
    });
    const report = vi.fn();
    await sample(host, ctx, model, params, new AbortController().signal, report);
    expect(report).toHaveBeenCalledWith({
      model: `${model.provider}/${model.id}`,
      usage: undefined,
      complete: false,
    });
  });
  it("preserves reported reasoning usage, including explicit zero and partial samples", () => {
    expect(sumUsage([{ model: "test", complete: false, usage }])?.reasoning).toBeUndefined();
    expect(
      sumUsage([{ model: "test", complete: true, usage: { ...usage, reasoning: 0 } }])?.reasoning,
    ).toBe(0);
    expect(
      sumUsage([
        { model: "test", complete: false, usage: { ...usage, reasoning: 2 } },
        { model: "test", complete: true, usage: { ...usage, reasoning: 3 } },
      ]),
    ).toMatchObject({ reasoning: 5, totalTokens: 66 });
  });
});
