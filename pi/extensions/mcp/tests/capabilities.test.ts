import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { ContextClient } from "../capabilities.js";
import { connectToServer } from "../connection.js";
import type { SamplingUsage } from "../sampling.js";
import { fixtureServer, setupMcpTest } from "./helpers.js";

const model = fauxProvider().getModel();

describe("MCP SDK input continuations", () => {
  const t = setupMcpTest();
  const host = () => t.createExtensionHost(() => {}, { hasUI: true, model });
  it.each(["modern", "legacy"])("preserves all form field names on the %s wire", async (era) => {
    const answers = ["prototype answer", "constructor answer", "string answer", "ordinary answer"];
    const selections = ["Fill form", "Accept"];
    const ctx = host().createContext({
      ui: {
        select: vi.fn(async () => selections.shift()),
        input: vi.fn(async () => answers.shift()),
      },
    });
    const connection = await connectToServer({
      serverConfig: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)), era],
      },
    });
    const signal = new AbortController().signal;
    try {
      const result = await connection.withContext!(
        { ctx, model, signal, reportUsage: () => {} },
        () => connection.client.callTool({ name: "interact" }, { signal }),
      );
      expect(result.content).toEqual([
        {
          type: "text",
          text: '{"action":"accept","content":{"__proto__":"prototype answer","constructor":"constructor answer","toString":"string answer","ordinary":"ordinary answer"}}',
        },
      ]);
      expect(answers).toEqual([]);
    } finally {
      await connection.close();
    }
  });
  it("serves legacy roots after initialization and while idle, with current-session and call ownership", async () => {
    let workspace: string | undefined = "/tmp/initial workspace";
    const connection = await connectToServer({
      serverConfig: {
        type: "stdio",
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)),
          "legacy",
          "roots",
        ],
      },
      getWorkspace: () => workspace,
    });
    const expected = (cwd: string | undefined) => [
      {
        type: "text",
        text: JSON.stringify({
          roots: cwd ? [{ uri: pathToFileURL(cwd).href, name: "Workspace" }] : [],
        }),
      },
    ];
    try {
      expect((await connection.client.callTool({ name: "startup-roots" })).content).toEqual(
        expected(workspace),
      );
      expect((await connection.client.callTool({ name: "interact" })).content).toEqual(
        expected(workspace),
      );
      workspace = "/tmp/next workspace";
      expect((await connection.client.callTool({ name: "interact" })).content).toEqual(
        expected(workspace),
      );
      const ctx = host().createContext({ cwd: "/tmp/originating workspace" });
      const signal = new AbortController().signal;
      const result = await connection.withContext!(
        { ctx, model, signal, reportUsage: () => {} },
        () => connection.client.callTool({ name: "interact" }, { signal }),
      );
      expect(result.content).toEqual(expected(ctx.cwd));
      expect((await connection.client.callTool({ name: "interact" })).content).toEqual(
        expected(workspace),
      );
      workspace = undefined;
      expect((await connection.client.callTool({ name: "interact" })).content).toEqual(
        expected(undefined),
      );
    } finally {
      await connection.close();
    }
  });

  it.each(["form", "sampling"])(
    "still rejects unsolicited legacy %s requests",
    async (scenario) => {
      const h = host();
      const connection = await connectToServer({
        serverConfig: {
          type: "stdio",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)),
            "legacy",
            scenario,
          ],
        },
        pi: h,
      });
      try {
        expect((await connection.client.callTool({ name: "interact" })).content).toEqual([
          {
            type: "text",
            text: expect.stringContaining("no unambiguous originating tool call"),
          },
        ]);
      } finally {
        await connection.close();
      }
    },
  );

  const invoke = async (
    scenario: string,
    ctx: ExtensionContext,
    options: {
      http?: boolean;
      args?: Record<string, unknown>;
      signal?: AbortSignal;
      pi?: Pick<ExtensionAPI, "events">;
    } = {},
  ) => {
    const fixture = options.http ? await t.startHttpFixture({ scenario }) : undefined;
    const connection = await connectToServer({
      serverConfig: fixture ? { type: "http", url: fixture.url } : fixtureServer(scenario),
      serverName: "fixture",
      pi: options.pi,
    });
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      connection.closed!,
    ]);
    const usage: SamplingUsage[] = [];
    try {
      const result = await connection.withContext!(
        { ctx, model: ctx.model, signal, reportUsage: (sample) => usage.push(sample) },
        () =>
          connection.client.callTool(
            { name: "interact", arguments: options.args ?? {} },
            { signal },
          ),
      );
      return { result, usage, fixture };
    } finally {
      await connection.close();
    }
  };

  it.each([false, true])("reports execution workspace through real SDK (http=%s)", async (http) => {
    const ctx = host().createContext({ cwd: "/tmp/mcp workspace" });
    const { result, fixture } = await invoke("roots", ctx, { http });
    expect(
      JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : ""),
    ).toMatchObject({ roots: { roots: [{ uri: pathToFileURL(ctx.cwd).href }] } });
    if (fixture) expect(fixture.state.operations).toBe(1);
  });

  it("preserves typed form answers and continues multiple rounds without replaying operations", async () => {
    const selections = [
      "Fill form",
      "true",
      "2. two",
      "1. red",
      "Done",
      "Accept",
      "Fill form",
      "false",
      "1. one",
      "Done",
      "Accept",
    ];
    const inputs = ["Ada", "3", "Grace", "4"];
    const ctx = host().createContext({
      ui: {
        select: vi.fn(async () => selections.shift()),
        input: vi.fn(async () => inputs.shift()),
      },
    });
    const { result, fixture } = await invoke("rounds", ctx, { http: true, args: { rounds: 2 } });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          form: {
            action: "accept",
            content: { name: "Grace", count: 4, enabled: false, choice: "one", tags: [] },
          },
        }),
      },
    ]);
    expect(fixture!.state.operations).toBe(1);
    expect(fixture!.state.records.map((record) => record.round)).toEqual([0, 1, 2]);
  });

  it.each(["Decline", "Cancel"])("handles %s without fabricated form content", async (answer) => {
    const ctx = host().createContext({ ui: { select: vi.fn(async () => answer) } });
    const { result } = await invoke("form", ctx, { http: true });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ form: { action: answer.toLowerCase() } }) },
    ]);
  });

  it("keeps overlapping HTTP calls bound to their own workspaces", async () => {
    const fixture = await t.startHttpFixture({ scenario: "roots" });
    const connection = await connectToServer({ serverConfig: { type: "http", url: fixture.url } });
    const contexts = [
      host().createContext({ cwd: "/tmp/first" }),
      host().createContext({ cwd: "/tmp/second" }),
    ];
    try {
      const results = await Promise.all(
        contexts.map((ctx) => {
          const signal = new AbortController().signal;
          return connection.withContext!({ ctx, model, signal, reportUsage: () => {} }, () =>
            connection.client.callTool({ name: "interact" }, { signal }),
          );
        }),
      );
      for (const [index, result] of results.entries())
        expect(result.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({
              roots: {
                roots: [{ uri: pathToFileURL(contexts[index]!.cwd).href, name: "Workspace" }],
              },
            }),
          },
        ]);
      expect(fixture.state.operations).toBe(2);
    } finally {
      await connection.close();
    }
  });

  it("uses session roots when a modern request has no origin among overlapping calls", async () => {
    const fixture = await t.startHttpFixture({ scenario: "roots" });
    const workspace = "/tmp/session workspace";
    const connection = await connectToServer({
      serverConfig: { type: "http", url: fixture.url },
      getWorkspace: () => workspace,
    });
    const gate = Promise.withResolvers<void>();
    const active = ["first", "second"].map((name) =>
      connection.withContext!(
        {
          ctx: host().createContext({ cwd: `/tmp/${name}` }),
          model,
          signal: new AbortController().signal,
          reportUsage: () => {},
        },
        () => gate.promise,
      ),
    );
    try {
      const result = await connection.client.callTool({ name: "interact" });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            roots: { roots: [{ uri: pathToFileURL(workspace).href, name: "Workspace" }] },
          }),
        },
      ]);
    } finally {
      gate.resolve();
      await Promise.all(active);
      await connection.close();
    }
  });

  it("shows requesting server and destination before user-directed URL navigation", async () => {
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockResolvedValueOnce("Open URL")
      .mockResolvedValueOnce("Completed");
    const ctx = host().createContext({ mode: "rpc", ui: { select } });
    const { result } = await invoke("url", ctx, { http: true });
    expect(select.mock.calls[0]![0]).toContain("MCP fixture");
    expect(select.mock.calls[0]![0]).toContain("/interaction");
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ url: { action: "accept" } }) },
    ]);
  });

  it.each(["abort", "close"])(
    "releases active and queued prompts when calls %s",
    async (action) => {
      const fixture = await t.startHttpFixture({ scenario: "form" });
      const connection = await connectToServer({
        serverConfig: { type: "http", url: fixture.url },
      });
      const controller = new AbortController();
      const select = vi.fn<ExtensionContext["ui"]["select"]>(
        (_title, _choices, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
              once: true,
            }),
          ),
      );
      const ctx = host().createContext({ ui: { select } });
      const calls = [1, 2].map(() => {
        const signal = AbortSignal.any([controller.signal, connection.closed!]);
        return connection.withContext!({ ctx, model, signal, reportUsage: () => {} }, () =>
          connection.client.callTool({ name: "interact" }, { signal }),
        );
      });
      const settled = Promise.allSettled(calls);
      await expect.poll(() => select.mock.calls.length).toBe(1);
      if (action === "abort") controller.abort();
      else await connection.close();
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
      expect(select).toHaveBeenCalledOnce();
      expect(fixture.state.operations).toBe(0);
      await connection.close();
    },
  );

  it("uses deterministic sampling automatically with the originating model and accounts every round", async () => {
    const h = host();
    const dispose = vi.fn(async () => {});
    h.events.on("clanker-codex:sampling-scope-request", (request) => {
      // SAFETY: This listener receives only the sampling request emitted by sample() in this test.
      const typed = request as { maxTokens: number; resolve: (scope: Promise<unknown>) => void };
      expect(typed.maxTokens).toBe(8);
      typed.resolve(
        Promise.resolve({
          run: <T>(run: () => T) => run(),
          boundText: (text: string) => text,
          dispose,
          status: { limitReached: true, usageComplete: true, usage: response.usage },
        }),
      );
    });
    const response = {
      ...fauxAssistantMessage("one two"),
      stopReason: "length" as const,
      usage: {
        input: 11,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const complete = vi.fn<ExtensionContext["modelRegistry"]["complete"]>(async () => response);
    const ctx = h.createContext({
      modelRegistry: { complete: (model, context, options) => complete(model, context, options) },
    });
    const { result, usage, fixture } = await invoke("sampling", ctx, {
      pi: h,
      http: true,
      args: { rounds: 2 },
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0]).toBe(model);
    expect(complete.mock.calls[0]![1]).toMatchObject({
      systemPrompt: "You are the fixture sampling model.",
      messages: [{ role: "user" }],
    });
    expect(complete.mock.calls[0]![1].tools).toBeUndefined();
    expect(complete.mock.calls[0]![2]).toMatchObject({ maxTokens: 8, maxRetries: 0 });
    expect(usage.map((item) => item.usage!.totalTokens)).toEqual([20, 20]);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"stopReason":"maxTokens"'),
    });
    expect(fixture!.state.operations).toBe(1);
  });
  it("cancels a queued legacy call immediately without starting it", async () => {
    const client = new ContextClient();
    const ctx = host().createContext();
    const gate = Promise.withResolvers<void>();
    const first = client.withContext(
      { ctx, model, signal: new AbortController().signal, reportUsage: () => {} },
      () => gate.promise,
    );
    const controller = new AbortController();
    const run = vi.fn(async () => "unexpected");
    const second = client.withContext(
      { ctx, model, signal: controller.signal, reportUsage: () => {} },
      run,
    );
    const rejected = expect(second).rejects.toThrow("cancel queued");
    controller.abort(new Error("cancel queued"));
    await rejected;
    expect(run).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    await client.close();
  });

  it("cancels a legacy form on SDK timeout and releases the next call without caller abort", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const select = vi.fn<ExtensionContext["ui"]["select"]>(
      (_title, _choices, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => {
            cancelled();
            reject(options!.signal!.reason);
          });
        }),
    );
    const ctx = host().createContext({ ui: { select } });
    const connection = await connectToServer({
      serverConfig: {
        type: "stdio",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)), "legacy"],
      },
    });
    const owned = { ctx, model, signal: controller.signal, reportUsage: () => {} };
    let parentError: unknown;
    const first = connection.withContext!(owned, () =>
      connection.client
        .callTool({ name: "interact" }, { signal: owned.signal, timeout: 100 })
        .catch((error: unknown) => {
          parentError = error;
          throw error;
        }),
    ).catch((error: unknown) => error);
    const next = vi.fn(() =>
      connection.client.callTool({ name: "ping" }, { signal: owned.signal }),
    );
    const second = connection.withContext!(owned, next);
    try {
      await expect.poll(() => select.mock.calls.length).toBe(1);
      expect(next).not.toHaveBeenCalled();
      await expect.poll(() => cancelled.mock.calls.length).toBe(1);
      expect(await first).toBe(parentError);
      expect(parentError).toMatchObject({
        code: "REQUEST_TIMEOUT",
        message: expect.stringContaining("timed out"),
      });
      expect((await second).content).toEqual([{ type: "text", text: '"pong"' }]);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      controller.abort();
      await Promise.allSettled([first, second]);
      await connection.close();
    }
  });

  it("awaits sampling disposal and reports usage after a legacy parent times out", async () => {
    const h = host();
    const controller = new AbortController();
    const disposal = Promise.withResolvers<void>();
    const dispose = vi.fn(() => disposal.promise);
    const usage = { ...fauxAssistantMessage("partial").usage, output: 3, totalTokens: 3 };
    h.events.on("clanker-codex:sampling-scope-request", (request) => {
      // SAFETY: Only sample() emits this event in this test.
      const typed = request as { resolve: (scope: Promise<unknown>) => void };
      typed.resolve(
        Promise.resolve({
          run: <T>(run: () => T) => run(),
          boundText: (text: string) => text,
          dispose,
          status: { limitReached: false, usageComplete: false, usage },
        }),
      );
    });
    const complete = vi.fn<ExtensionContext["modelRegistry"]["complete"]>(
      (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason));
        }),
    );
    const ctx = h.createContext({
      modelRegistry: { complete: (model, context, options) => complete(model, context, options) },
    });
    const reportUsage = vi.fn<(sample: SamplingUsage) => void>();
    const connection = await connectToServer({
      serverConfig: {
        type: "stdio",
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/elicitation-peer.ts", import.meta.url)),
          "legacy",
          "sampling",
        ],
      },
      pi: h,
    });
    let settled = false;
    let parentError: unknown;
    const call = connection.withContext!(
      { ctx, model, signal: controller.signal, reportUsage },
      () =>
        connection.client
          .callTool({ name: "interact" }, { signal: controller.signal, timeout: 100 })
          .catch((error: unknown) => {
            parentError = error;
            throw error;
          }),
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await expect.poll(() => dispose.mock.calls.length).toBe(1);
      expect(complete).toHaveBeenCalledOnce();
      expect(complete.mock.calls[0]![2]!.signal!.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      expect(settled).toBe(false);
      expect(reportUsage).not.toHaveBeenCalled();
      disposal.resolve();
      expect(await call).toBe(parentError);
      expect(parentError).toMatchObject({
        code: "REQUEST_TIMEOUT",
        message: expect.stringContaining("timed out"),
      });
      expect(reportUsage).toHaveBeenCalledExactlyOnceWith({
        model: `${model.provider}/${model.id}`,
        usage,
        complete: false,
      });
    } finally {
      controller.abort();
      disposal.resolve();
      await call;
      await connection.close();
    }
  });

  it("cancels only the failed modern call while another call is waiting for input", async () => {
    const fixture = await t.startHttpFixture({ scenario: "form" });
    const connection = await connectToServer({ serverConfig: { type: "http", url: fixture.url } });
    const answer = Promise.withResolvers<string>();
    const failed = Promise.withResolvers<never>();
    const cancelled = [vi.fn(), vi.fn()];
    const selections = cancelled.map((cancelled) =>
      vi.fn<ExtensionContext["ui"]["select"]>(
        (_title, _options, options) =>
          new Promise((resolve, reject) => {
            options!.signal!.addEventListener("abort", () => {
              cancelled();
              reject(options!.signal!.reason);
            });
            void answer.promise.then(resolve);
          }),
      ),
    );
    const controllers = [new AbortController(), new AbortController()];
    const contexts = selections.map((select) => host().createContext({ ui: { select } }));
    const calls = contexts.map((ctx, index) => {
      const signal = controllers[index]!.signal;
      return connection.withContext!({ ctx, model, signal, reportUsage: () => {} }, () => {
        const call = connection.client.callTool({ name: "interact" }, { signal });
        return index === 0 ? Promise.race([call, failed.promise]) : call;
      });
    });
    const failure = new Error("parent failed");
    const first = expect(calls[0]).rejects.toBe(failure);
    try {
      await expect.poll(() => selections.map((select) => select.mock.calls.length)).toEqual([1, 1]);
      failed.reject(failure);
      await first;
      expect(cancelled[0]).toHaveBeenCalledOnce();
      expect(cancelled[1]).not.toHaveBeenCalled();
      expect(controllers.every((controller) => !controller.signal.aborted)).toBe(true);
      answer.resolve("Decline");
      expect((await calls[1])!.content).toEqual([
        { type: "text", text: JSON.stringify({ form: { action: "decline" } }) },
      ]);
    } finally {
      controllers.forEach((controller) => controller.abort());
      answer.resolve("Cancel");
      await Promise.allSettled(calls);
      await connection.close();
    }
  });
});
