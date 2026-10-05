import { okFetch } from "./adapters/helpers.js";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import type { GetAuth } from "../auth.js";
import { resolveRadiusBillingUrl } from "../controller.js";
import type { FetchJson } from "../http.js";
import { createUsageExtension } from "../index.js";

const claudeModel: Model<Api> = {
  api: "test",
  baseUrl: "",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-5",
  input: ["text"],
  maxTokens: 16_000,
  name: "gpt-5",
  provider: "anthropic",
  reasoning: true,
};

const radiusModel: Model<Api> = {
  ...claudeModel,
  id: "balanced",
  name: "Balanced",
  provider: "radius",
};

const oauth: GetAuth = async () => ({ auth: { apiKey: "fake-token" }, source: "OAuth" });

const successfulFetchJson: FetchJson = okFetch({
  five_hour: { utilization: 32 },
  seven_day: { utilization: 66 },
});

const client = { fetchJson: successfulFetchJson };

let fetchJson = vi.spyOn(client, "fetchJson");

const stubDependencies = (
  nowRef: { value: number },
  radiusBillingUrl: string | null = "https://radius.pi.dev/v1/billing",
) => {
  fetchJson = vi.spyOn(client, "fetchJson");
  fetchJson.mockReset();
  fetchJson.mockImplementation(successfulFetchJson);

  return createUsageExtension({
    fetchJson: client.fetchJson,
    now: () => nowRef.value,
    getAuth: () => oauth,
    radiusBillingUrl: () => radiusBillingUrl ?? undefined,
  });
};

describe("usage controller", () => {
  it("targets failed physical routes through turn ends, settlement, and branch reconstruction", async () => {
    const session = SessionManager.inMemory();
    const original = session.appendMessage({ role: "user", content: "start", timestamp: 1000 });
    const auth = vi.fn<GetAuth>(async () => ({ auth: { apiKey: "token" }, source: "OAuth" }));

    const host = createExtensionHost(
      createUsageExtension({
        now: () => 1000,
        getAuth: () => auth,
        radiusBillingUrl: () => "https://gateway.example/v1/billing",
        fetchJson: async (url, schema, options) =>
          okFetch(
            url.includes("/v1/billing")
              ? {
                  balance: { available: 0, credit_balance: 0, reserved: 0 },
                  currency: "USD",
                  current_period: { actual_charged: 30, ends_at: "2026-10-01T00:00:00.000Z" },
                  ok: true,
                }
              : { five_hour: { utilization: 30 } },
          )(url, schema, options),
      }),
      {
        model: { ...claudeModel, api: "pi-virtual", provider: "router", id: "auto", name: "Auto" },
      },
    );

    const ctx = host.createContext({ sessionManager: session });
    const active = () => host.getStatus("usage");
    await host.emitSessionStart(ctx);

    // turn_end runs after Pi has appended the response.
    session.appendMessage({ ...fauxAssistantMessage("done"), provider: "anthropic", model: "x" });
    await host.emit("turn_end", { type: "turn_end" }, ctx);
    await vi.waitFor(() => expect(active()).toMatch(/^Claude 5h .* 30%$/));
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emit("model_select", { type: "model_select", model: ctx.model }, ctx);
    expect(active()).toMatch(/^Claude 5h /);

    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exhausted" }),
      provider: "radius",
    });
    await host.emit("turn_end", { type: "turn_end" }, ctx);
    await vi.waitFor(() => expect(active()).toBe("Radius $0.00 available"));

    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      api: "pi-virtual",
      provider: "router",
    });
    await host.emitSessionTree(ctx);
    expect(active()).toBe("Radius $0.00 available");
    expect(auth.mock.calls.map(([provider]) => provider)).toEqual(["anthropic", "radius"]);

    // A physical selection changes quota immediately, even after a different routed attempt.
    const physical = host.createContext({ sessionManager: session, model: claudeModel });
    await host.emit("model_select", { type: "model_select", model: claudeModel }, physical);
    expect(active()).toMatch(/^Claude 5h /);

    session.branch(original);
    await host.emitSessionTree(ctx);
    expect(active()).toBeUndefined();
    await host.emitSessionShutdown(ctx);
  });

  it.each(["selected", "routed", "routed-with-account"] as const)(
    "explains unsupported OpenAI quotas on demand without fetching another account for it (%s)",
    async (scenario) => {
      const session = SessionManager.inMemory();

      if (scenario !== "selected")
        session.appendMessage({
          ...fauxAssistantMessage("done"),
          provider: "openai",
          model: "physical",
        });

      const auth = vi.fn<GetAuth>(async (provider) =>
        scenario === "routed-with-account" && provider === "anthropic"
          ? { auth: { apiKey: "offline" }, source: "OAuth" }
          : undefined,
      );

      const fetchClient = { fetchJson: successfulFetchJson };
      const fetch = vi.spyOn(fetchClient, "fetchJson");

      const host = createExtensionHost(
        createUsageExtension({
          fetchJson: fetchClient.fetchJson,
          now: () => 1000,
          getAuth: () => auth,
          radiusBillingUrl: () => undefined,
        }),
        {
          model:
            scenario === "selected"
              ? { ...claudeModel, provider: "openai" }
              : { ...claudeModel, api: "pi-virtual", provider: "router", id: "auto" },
        },
      );

      const ctx = host.createContext({ sessionManager: session });
      await host.emitSessionStart(ctx);
      await host.runCommand("usage", "", ctx);
      const message = host.getNotifications().at(-1)?.message;
      expect(message).toContain("usage: quota reporting is unsupported for openai");
      expect(message).not.toContain("log in");
      expect(host.getStatus("usage")).toBeUndefined();

      if (scenario === "routed-with-account") {
        expect(message).toContain("Claude");
        expect(fetch).toHaveBeenCalledTimes(1);
      } else expect(fetch).not.toHaveBeenCalled();
      await host.emitSessionShutdown(ctx);
    },
  );

  it("names why the target's usage is unavailable, but not other providers'", async () => {
    const host = createExtensionHost(
      createUsageExtension({
        fetchJson: successfulFetchJson,
        now: () => 1000,
        getAuth: () => async (provider) =>
          provider === "anthropic"
            ? { auth: { apiKey: "sk-ant" }, source: "ANTHROPIC_API_KEY" }
            : undefined,
        radiusBillingUrl: () => undefined,
      }),
      { model: claudeModel },
    );

    const ctx = host.createContext({ model: claudeModel });
    await host.emitSessionStart(ctx);
    await vi.waitFor(() => expect(host.getStatus("usage")).toBe("Claude usage unavailable"));
    await host.runCommand("usage", "", ctx);

    expect(host.getNotifications().at(-1)?.message).toBe(
      "usage: anthropic: subscription usage requires OAuth login (not API key)",
    );
    await host.emitSessionShutdown(ctx);
  });

  it.each(["settled", "model", "shutdown"] as const)(
    "delivers account results across refreshes but not shutdown (%s)",
    async (event) => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const host = createExtensionHost(
        createUsageExtension({
          now: () => 1000,
          radiusBillingUrl: () => undefined,
          getAuth: () => async (provider) =>
            provider === "anthropic" ? { auth: { apiKey: "offline" }, source: "OAuth" } : undefined,
          fetchJson: async (url, schema, options) => {
            started.resolve();
            await release.promise;

            return okFetch({ five_hour: { utilization: 20 } })(url, schema, options);
          },
        }),
        { model: claudeModel },
      );

      await host.ready;
      const ctx = host.createContext({ model: claudeModel });
      const command = host.runCommand("usage", "", ctx);
      await started.promise;

      if (event === "settled") await host.emit("agent_settled", { type: "agent_settled" }, ctx);
      else if (event === "model")
        await host.emit(
          "model_select",
          { type: "model_select", model: radiusModel, previousModel: claudeModel, source: "set" },
          host.createContext({ model: radiusModel }),
        );
      else await host.emitSessionShutdown(ctx);
      release.resolve();
      await command;
      expect(host.getNotifications()).toHaveLength(event === "shutdown" ? 0 : 1);

      if (event !== "shutdown") await host.emitSessionShutdown(ctx);
    },
  );

  it("does not lose a command when the periodic refresh runs", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let delayFetch = false;

    const host = createExtensionHost(
      createUsageExtension({
        now: () => 1000,
        radiusBillingUrl: () => undefined,
        getAuth: () => async (provider) =>
          provider === "anthropic" ? { auth: { apiKey: "offline" }, source: "OAuth" } : undefined,
        fetchJson: async (url, schema, options) => {
          if (delayFetch) {
            entered.resolve();
            await release.promise;
          }

          return okFetch({ five_hour: { utilization: 20 } })(url, schema, options);
        },
      }),
      { model: claudeModel },
    );

    await host.ready;
    const ctx = host.createContext({ model: claudeModel });
    await host.runCommand("usage", "", ctx);
    vi.useFakeTimers();

    try {
      await host.emitSessionStart(ctx);
      delayFetch = true;
      const command = host.runCommand("usage", "refresh", ctx);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      release.resolve();
      await command;
      expect(host.getNotifications()).toHaveLength(2);
    } finally {
      release.resolve();
      await host.emitSessionShutdown(ctx);
      vi.useRealTimers();
    }
  });

  it("resolves one effective Radius gateway and rejects ambiguity", () => {
    expect(
      resolveRadiusBillingUrl([
        undefined,
        "https://gateway.example/v1",
        "https://gateway.example/v1/",
      ]),
    ).toBe("https://gateway.example/v1/billing");
    expect(
      resolveRadiusBillingUrl(["https://gateway.example/v1", "https://other.example/v1"]),
    ).toBeUndefined();
    expect(resolveRadiusBillingUrl(["not a URL"])).toBeUndefined();
  });

  it("publishes the active usage as a native status and clears it on shutdown", async () => {
    const extension = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: claudeModel });
    const context = host.createContext({ model: claudeModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66%$/);
    });
    await host.emitSessionShutdown(context);
    expect(host.getStatus("usage")).toBeUndefined();
  });

  it("renders Radius balance usage from the effective gateway", async () => {
    const extension = stubDependencies({ value: 1000 }, "https://gateway.example/v1/billing");
    fetchJson.mockImplementation(
      okFetch({
        balance: { available: 43.26, credit_balance: 46.51, reserved: 3.25 },
        currency: "USD",
        current_period: {
          actual_charged: 33.48,
          ends_at: "2026-10-01T00:00:00.000Z",
        },
        ok: true,
      }),
    );
    const host = createExtensionHost(extension, { model: radiusModel });
    const context = host.createContext({ model: radiusModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toBe("Radius $43.26 available");
    });
    expect(fetchJson.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/billing");
    await host.emitSessionShutdown(context);
  });

  it("does not send a Radius credential without an unambiguous gateway", async () => {
    const extension = stubDependencies({ value: 1000 }, null);
    const host = createExtensionHost(extension, { model: radiusModel });
    const context = host.createContext({ model: radiusModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toBe("Radius usage unavailable");
    });
    expect(fetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("does not fetch usage automatically outside TUI mode", async () => {
    const extension = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: claudeModel });
    const context = host.createContext({ mode: "rpc", model: claudeModel });

    await host.emitSessionStart(context);
    await host.emit("agent_settled", { type: "agent_settled" }, context);

    expect(fetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("does not let a stale command refresh overwrite a model switch", async () => {
    const extension = stubDependencies({ value: 1000 });

    const radius = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();

    const claude = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();

    fetchJson.mockImplementation(async (url, schema, options) => {
      if (url.includes("/v1/billing")) {
        return okFetch((await radius.promise).json)(url, schema, options);
      }

      if (url.includes("anthropic.com")) {
        return okFetch((await claude.promise).json)(url, schema, options);
      }

      return { kind: "response", message: "unavailable", ok: false };
    });
    const host = createExtensionHost(extension, { model: radiusModel });
    const radiusContext = host.createContext({ model: radiusModel });

    const command = host.runCommand("usage", "", radiusContext);
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
      );
    });
    const claudeContext = host.createContext({ model: claudeModel });
    await host.emit(
      "model_select",
      {
        model: claudeModel,
        previousModel: radiusModel,
        source: "set",
        type: "model_select",
      },
      claudeContext,
    );
    claude.resolve({
      json: {
        five_hour: { utilization: 10 },
      },
      ok: true,
    });
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("Claude");
    });

    radius.resolve({
      json: {
        ok: true,
        currency: "USD",
        balance: { available: 9, credit_balance: 10, reserved: 1 },
        current_period: { actual_charged: 1, ends_at: "2026-10-01T00:00:00Z" },
      },
      ok: true,
    });
    await command;

    expect(host.getStatus("usage")).toContain("Claude");
    await host.emitSessionShutdown(claudeContext);
  });

  it("publishes loading, error, ready, and stale status text", async () => {
    const nowRef = { value: 1000 };
    const extension = stubDependencies(nowRef);
    let requests = 0;
    fetchJson.mockImplementation(async (url, schema, options) => {
      requests += 1;

      if (requests === 2) {
        return successfulFetchJson(url, schema, options);
      }

      return { kind: "response", message: "boom\n[31mred", ok: false };
    });
    const host = createExtensionHost(extension, { model: claudeModel });
    const context = host.createContext({ model: claudeModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(requests).toBe(1);
      expect(host.getStatus("usage")).toBe("Claude usage unavailable");
    });
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await vi.waitFor(() => {
      expect(requests).toBe(2);
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66%$/);
    });

    nowRef.value = 61_000;
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await vi.waitFor(() => {
      expect(requests).toBe(3);
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66% !$/);
    });

    expect(vi.mocked(context.ui.setStatus).mock.calls[0]).toEqual([
      "usage",
      "Claude usage loading",
    ]);

    await host.emitSessionShutdown(context);
  });
});
