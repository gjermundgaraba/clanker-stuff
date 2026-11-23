import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/all";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { CLAUDE_BRIDGE_PLAN_USAGE_HEADER } from "../adapters/claude-bridge.js";
import { contextAuth } from "../auth.js";
import type { GetAuth } from "../auth.js";
import { resolveRadiusBillingUrl } from "../controller.js";
import type { FetchJson } from "../http.js";
import { createUsageExtension } from "../index.js";
import { CODEX_TOKEN, okFetch } from "./adapters/helpers.js";

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

const oauth: GetAuth = async () => ({
  auth: { apiKey: "fake-token" },
  source: "OAuth",
});

const radiusPayload = (available: number) => ({
  balance: { available, credit_balance: available, reserved: 0 },
  currency: "USD",
  current_period: { actual_charged: 30, ends_at: "2026-10-01T00:00:00Z" },
  ok: true,
});

const radiusHost = (fetchJson: FetchJson) => {
  const host = createExtensionHost(
    createUsageExtension({
      fetchJson,
      now: () => 1000,
      getAuth: () => async (provider) =>
        provider === "radius" ? await oauth(provider) : undefined,
    })
  );

  const contextFor = (baseUrl: string) => {
    const provider = {
      ...radiusProvider(),
      getModels: () => [
        { ...radiusModel, api: "pi-messages" as const, baseUrl },
      ],
    };

    return host.createContext({
      model: radiusModel,
      modelRegistry: {
        getProvider: (id) => (id === "radius" ? provider : undefined),
      },
    });
  };

  return { host, contextFor };
};

const successfulFetchJson: FetchJson = okFetch({
  five_hour: { utilization: 32 },
  seven_day: { utilization: 66 },
});

const stubDependencies = (
  nowRef: { value: number },
  radiusBillingUrl: string | null = "https://radius.pi.dev/v1/billing"
) => {
  const client = { fetchJson: successfulFetchJson };
  const fetchJson = vi.spyOn(client, "fetchJson");

  return {
    fetchJson,
    extension: createUsageExtension({
      fetchJson: client.fetchJson,
      now: () => nowRef.value,
      getAuth: () => oauth,
      radiusBillingUrl: () => radiusBillingUrl ?? undefined,
    }),
  };
};

describe("usage controller", () => {
  it("targets failed physical routes through turn ends, settlement, and branch reconstruction", async () => {
    const session = SessionManager.inMemory();

    const original = session.appendMessage({
      role: "user",
      content: "start",
      timestamp: 1000,
    });

    const urls: string[] = [];

    const fetchJson: FetchJson = async (url, schema, headers) => {
      urls.push(url);

      return await okFetch(
        url.includes("/v1/billing")
          ? radiusPayload(0)
          : { five_hour: { utilization: 30 } }
      )(url, schema, headers);
    };

    const host = createExtensionHost(
      createUsageExtension({
        now: () => 1000,
        getAuth: () => oauth,
        radiusBillingUrl: () => "https://gateway.example/v1/billing",
        fetchJson,
      }),
      {
        model: {
          ...claudeModel,
          api: "pi-virtual",
          provider: "router",
          id: "auto",
          name: "Auto",
        },
      }
    );

    const ctx = host.createContext({ sessionManager: session });
    const active = () => host.getStatus("usage");
    await host.emitSessionStart(ctx);

    session.appendMessage({
      ...fauxAssistantMessage("done"),
      provider: "anthropic",
      model: "x",
    });
    await host.emit("turn_end", { type: "turn_end" }, ctx);
    await vi.waitFor(() => {
      expect(active()).toMatch(/^Claude 5h .* 30%$/u);
    });
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emit(
      "model_select",
      { type: "model_select", model: ctx.model },
      ctx
    );
    expect(active()).toMatch(/^Claude 5h /u);

    session.appendMessage({
      ...fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "quota exhausted",
      }),
      provider: "radius",
    });
    await host.emit("turn_end", { type: "turn_end" }, ctx);
    await vi.waitFor(() => {
      expect(active()).toBe("Radius $0.00 available");
    });

    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      api: "pi-virtual",
      provider: "router",
    });
    await host.emitSessionTree(ctx);
    expect(active()).toBe("Radius $0.00 available");
    expect(urls).toStrictEqual([
      "https://api.anthropic.com/api/oauth/usage",
      "https://gateway.example/v1/billing",
    ]);

    const physical = host.createContext({
      sessionManager: session,
      model: claudeModel,
    });

    await host.emit(
      "model_select",
      { type: "model_select", model: claudeModel },
      physical
    );
    await vi.waitFor(() => {
      expect(active()).toMatch(/^Claude 5h /u);
    });

    session.branch(original);
    await host.emitSessionTree(ctx);
    expect(active()).toBeUndefined();
    await host.emitSessionShutdown(ctx);
  });

  it.each(["selected", "routed", "routed-with-account"] as const)(
    "explains unsupported OpenAI quotas on demand without fetching another account for it (%s)",
    async (scenario) => {
      const session = SessionManager.inMemory();

      if (scenario !== "selected") {
        session.appendMessage({
          ...fauxAssistantMessage("done"),
          provider: "openai",
          model: "physical",
        });
      }

      const auth = vi.fn<GetAuth>(async (provider) =>
        scenario === "routed-with-account" && provider === "anthropic"
          ? { auth: { apiKey: "offline" }, source: "OAuth" }
          : undefined
      );

      const fetchClient = { fetchJson: successfulFetchJson };
      const fetch = vi.spyOn(fetchClient, "fetchJson");

      const host = createExtensionHost(
        createUsageExtension({
          fetchJson: fetchClient.fetchJson,
          now: () => 1000,
          getAuth: () => auth,
          radiusBillingUrl: () => {},
        }),
        {
          model:
            scenario === "selected"
              ? { ...claudeModel, provider: "openai" }
              : {
                  ...claudeModel,
                  api: "pi-virtual",
                  provider: "router",
                  id: "auto",
                },
        }
      );

      const ctx = host.createContext({ sessionManager: session });
      await host.emitSessionStart(ctx);
      await host.runCommand("usage", "", ctx);
      const message = host.getNotifications().at(-1)?.message;
      expect(message).toContain(
        "usage: quota reporting is unsupported for openai"
      );
      expect(message).not.toContain("log in");
      expect(host.getStatus("usage")).toBeUndefined();

      const withAccount = scenario === "routed-with-account";

      expect(message?.includes("Claude"), message).toBe(withAccount);
      expect(fetch).toHaveBeenCalledTimes(withAccount ? 1 : 0);

      await host.emitSessionShutdown(ctx);
    }
  );

  it("lists Codex separately and never substitutes its quota for native OpenAI", async () => {
    const auth = vi.fn<GetAuth>(async (provider) =>
      provider === "openai-codex"
        ? { auth: { apiKey: CODEX_TOKEN }, source: "OAuth" }
        : undefined
    );

    const client = {
      fetchJson: okFetch({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 35, limit_window_seconds: 18_000 },
        },
        additional_rate_limits: [
          {
            limit_name: "Spark",
            rate_limit: {
              primary_window: {
                used_percent: 100,
                limit_window_seconds: 18_000,
              },
            },
          },
        ],
      }),
    };

    const fetchJson = vi.spyOn(client, "fetchJson");
    const nativeModel = { ...claudeModel, provider: "openai" };
    const codexModel = { ...claudeModel, provider: "openai-codex" };

    const host = createExtensionHost(
      createUsageExtension({
        fetchJson: client.fetchJson,
        now: () => 1000,
        getAuth: () => auth,
        radiusBillingUrl: () => {},
      }),
      { model: nativeModel }
    );

    const native = host.createContext({ model: nativeModel });

    await host.emitSessionStart(native);
    await host.runCommand("usage", "", native);
    expect(host.getNotifications().at(-1)?.message).toBe(
      "usage: quota reporting is unsupported for openai\n\nCodex (plus)\n5h  65% left  resets unknown\nSpark 5h  0% left  resets unknown"
    );
    expect(host.getStatus("usage")).toBeUndefined();
    expect(fetchJson).toHaveBeenCalledOnce();

    const codex = host.createContext({ model: codexModel });
    await host.emit(
      "model_select",
      { type: "model_select", model: codexModel },
      codex
    );
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toMatch(/^Codex \(plus\) 5h .* 35%$/u);
    });
    expect(fetchJson).toHaveBeenCalledOnce();

    await host.emit(
      "model_select",
      { type: "model_select", model: nativeModel },
      native
    );
    expect(host.getStatus("usage")).toBeUndefined();
    await host.emitSessionShutdown(native);
  });

  it("names why the target's usage is unavailable, but not other providers'", async () => {
    const host = createExtensionHost(
      createUsageExtension({
        fetchJson: successfulFetchJson,
        now: () => 1000,
        getAuth: () => async (provider) =>
          provider === "anthropic"
            ? { auth: { apiKey: "sk-ant" }, source: "ANTHROPIC_API_KEY" }
            : undefined,
        radiusBillingUrl: () => {},
      }),
      { model: claudeModel }
    );

    const ctx = host.createContext({ model: claudeModel });
    await host.emitSessionStart(ctx);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toBe("Claude usage unavailable");
    });
    await host.runCommand("usage", "", ctx);

    expect(host.getNotifications().at(-1)?.message).toBe(
      "usage: anthropic: subscription usage requires OAuth login (not API key)"
    );
    await host.emitSessionShutdown(ctx);
  });

  it.each(["settled", "model", "shutdown"] as const)(
    "delivers account results across refreshes but not shutdown (%s)",
    async (event) => {
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();

      const host = createExtensionHost(
        createUsageExtension({
          now: () => 1000,
          radiusBillingUrl: () => {},
          getAuth: () => async (provider) =>
            provider === "anthropic"
              ? { auth: { apiKey: "offline" }, source: "OAuth" }
              : undefined,
          fetchJson: async (url, schema, headers) => {
            started.resolve(undefined);
            await release.promise;

            return await okFetch({ five_hour: { utilization: 20 } })(
              url,
              schema,
              headers
            );
          },
        }),
        { model: claudeModel }
      );

      await host.ready;
      const ctx = host.createContext({ model: claudeModel });
      const command = host.runCommand("usage", "", ctx);
      await started.promise;

      if (event === "settled") {
        await host.emit("agent_settled", { type: "agent_settled" }, ctx);
      } else if (event === "model") {
        await host.emit(
          "model_select",
          {
            type: "model_select",
            model: radiusModel,
            previousModel: claudeModel,
            source: "set",
          },
          host.createContext({ model: radiusModel })
        );
      } else {
        await host.emitSessionShutdown(ctx);
      }

      release.resolve(undefined);
      await command;
      expect(host.getNotifications()).toHaveLength(
        event === "shutdown" ? 0 : 1
      );

      if (event !== "shutdown") {
        await host.emitSessionShutdown(ctx);
      }
    }
  );

  it("does not lose a command when the periodic refresh runs", async () => {
    const release = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    let delayFetch = false;

    const host = createExtensionHost(
      createUsageExtension({
        now: () => 1000,
        radiusBillingUrl: () => {},
        getAuth: () => async (provider) =>
          provider === "anthropic"
            ? { auth: { apiKey: "offline" }, source: "OAuth" }
            : undefined,
        fetchJson: async (url, schema, headers) => {
          if (delayFetch) {
            entered.resolve(undefined);
            await release.promise;
          }

          return await okFetch({ five_hour: { utilization: 20 } })(
            url,
            schema,
            headers
          );
        },
      }),
      { model: claudeModel }
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
      release.resolve(undefined);
      await command;
      expect(host.getNotifications()).toHaveLength(2);
    } finally {
      release.resolve(undefined);
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
      ])
    ).toBe("https://gateway.example/v1/billing");
    expect(
      resolveRadiusBillingUrl([
        "https://gateway.example/v1",
        "https://other.example/v1",
      ])
    ).toBeUndefined();
    expect(resolveRadiusBillingUrl(["not a URL"])).toBeUndefined();
  });

  it.each([
    { name: "empty catalog", baseUrls: [] },
    { name: "missing URL", baseUrls: [undefined] },
    { name: "non-HTTP URL", baseUrls: ["ftp://gateway.example/v1"] },
    {
      name: "valid and malformed URLs",
      baseUrls: ["https://gateway.example/v1", "not a URL"],
    },
    {
      name: "valid and non-HTTP URLs",
      baseUrls: ["https://gateway.example/v1", "ftp://gateway.example/v1"],
    },
  ])("rejects missing or unsafe Radius gateways ($name)", ({ baseUrls }) => {
    expect(resolveRadiusBillingUrl(baseUrls)).toBeUndefined();
  });

  it("publishes the active usage as a native status and clears it on shutdown", async () => {
    const { extension } = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: claudeModel });
    const context = host.createContext({ model: claudeModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66%$/u);
    });
    await host.emitSessionShutdown(context);
    expect(host.getStatus("usage")).toBeUndefined();
  });

  it("shows claude-bridge usage from the header its responses report, whichever model is selected", async () => {
    const { extension, fetchJson } = stubDependencies({ value: 1000 });

    const bridgeModel: Model<Api> = {
      ...claudeModel,
      provider: "claude-bridge",
    };

    const host = createExtensionHost(extension, { model: bridgeModel });
    const context = host.createContext({ model: bridgeModel });

    const usageHeaders = {
      [CLAUDE_BRIDGE_PLAN_USAGE_HEADER]: JSON.stringify({
        five_hour: { utilization: 0.25 },
        seven_day: { utilization: 0.5 },
      }),
    };

    const anthropicHeaders = {
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
    };

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toBe("Claude Code usage unavailable");
    });

    await host.emit(
      "after_provider_response",
      {
        type: "after_provider_response",
        status: 200,
        headers: anthropicHeaders,
      },
      context
    );
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await yieldToEventLoop();
    expect(host.getStatus("usage")).toBe("Claude Code usage unavailable");

    await host.emit(
      "after_provider_response",
      { type: "after_provider_response", status: 200, headers: usageHeaders },
      host.createContext({ model: claudeModel })
    );
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toMatch(/^Claude Code week .* 50%$/u);
    });

    expect(fetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("renders Radius balance usage from the effective gateway", async () => {
    const { extension, fetchJson } = stubDependencies(
      { value: 1000 },
      "https://gateway.example/v1/billing"
    );

    fetchJson.mockImplementation(
      okFetch({
        balance: { available: 43.26, credit_balance: 46.51, reserved: 3.25 },
        currency: "USD",
        current_period: {
          actual_charged: 33.48,
          ends_at: "2026-10-01T00:00:00.000Z",
        },
        ok: true,
      })
    );
    const host = createExtensionHost(extension, { model: radiusModel });
    const context = host.createContext({ model: radiusModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toBe("Radius $43.26 available");
    });
    expect(fetchJson.mock.calls[0]?.[0]).toBe(
      "https://gateway.example/v1/billing"
    );
    await host.emitSessionShutdown(context);
  });

  it("does not reuse fresh or stale usage from a different Radius gateway", async () => {
    const firstUrl = "https://first.example/v1/billing";
    const secondUrl = "https://second.example/v1/billing";
    const urls: string[] = [];
    let secondAvailable = false;

    const fetchJson: FetchJson = async (url, schema, headers) => {
      urls.push(url);

      if (url === secondUrl && !secondAvailable) {
        return { message: "HTTP 503", ok: false, status: 503 };
      }

      return await okFetch(radiusPayload(url === firstUrl ? 12 : 34))(
        url,
        schema,
        headers
      );
    };

    const { host, contextFor } = radiusHost(fetchJson);
    const first = contextFor("https://first.example/v1");
    const second = contextFor("https://second.example/v1");
    const notification = () => host.getNotifications().at(-1)?.message;

    await host.runCommand("usage", "", first);
    expect(host.getStatus("usage")).toBe("Radius $12.00 available");
    expect(notification()).toContain("available  $12.00");

    await host.runCommand("usage", "", second);
    expect(host.getStatus("usage")).toBe("Radius usage unavailable");
    expect(notification()).toBe("usage: radius: HTTP 503");

    secondAvailable = true;
    await host.runCommand("usage", "", second);
    expect(host.getStatus("usage")).toBe("Radius $34.00 available");
    expect(notification()).toContain("available  $34.00");

    await host.runCommand(
      "usage",
      "",
      contextFor("https://second.example/another-path")
    );
    expect(notification()).toContain("available  $34.00");
    expect(urls).toStrictEqual([firstUrl, secondUrl, secondUrl]);
    await host.emitSessionShutdown(second);
  });

  it("deduplicates concurrent Radius reads only within the same billing scope", async () => {
    const firstUrl = "https://first.example/v1/billing";
    const secondUrl = "https://second.example/v1/billing";
    const firstGate = Promise.withResolvers<undefined>();
    const secondGate = Promise.withResolvers<undefined>();
    const urls: string[] = [];

    const fetchJson: FetchJson = async (url, schema, headers) => {
      urls.push(url);
      const first = url === firstUrl;
      await (first ? firstGate.promise : secondGate.promise);

      return await okFetch(radiusPayload(first ? 12 : 34))(
        url,
        schema,
        headers
      );
    };

    const { host, contextFor } = radiusHost(fetchJson);
    const first = contextFor("https://first.example/v1");
    const second = contextFor("https://second.example/v1");
    const readFirst = host.runCommand("usage", "", first);

    try {
      await vi.waitFor(() => {
        expect(urls).toStrictEqual([firstUrl]);
      });
      const readSecond = host.runCommand("usage", "refresh", second);
      const readSameScope = host.runCommand("usage", "refresh", second);
      await vi.waitFor(() => {
        expect(urls).toStrictEqual([firstUrl, secondUrl]);
      });
      secondGate.resolve(undefined);
      await Promise.all([readSecond, readSameScope]);
      const messages = host.getNotifications().map(({ message }) => message);
      expect(messages).toHaveLength(2);
      expect(
        messages.every((message) => message.includes("available  $34.00"))
      ).toBe(true);

      firstGate.resolve(undefined);
      await readFirst;
      expect(host.getNotifications().at(-1)?.message).toContain(
        "available  $12.00"
      );
      expect(host.getStatus("usage")).toBe("Radius $34.00 available");
      expect(urls).toStrictEqual([firstUrl, secondUrl]);
    } finally {
      firstGate.resolve(undefined);
      secondGate.resolve(undefined);
      await host.emitSessionShutdown(second);
    }
  });

  it("rechecks Pi's resolved credential before reusing quota data", async () => {
    let token: string | undefined = "initial-login";
    const authorizations: Array<string | undefined> = [];

    const fetchJson: FetchJson = async (url, schema, headers) => {
      const authorization = headers["Authorization"];
      authorizations.push(authorization);

      return await okFetch({
        five_hour: {
          utilization: authorization === "Bearer initial-login" ? 12 : 34,
        },
      })(url, schema, headers);
    };

    const host = createExtensionHost(
      createUsageExtension({
        fetchJson,
        getAuth: (ctx) => contextAuth(ctx, () => undefined),
        now: () => 1000,
        radiusBillingUrl: () => undefined,
      })
    );

    const ctx = host.createContext({
      model: claudeModel,
      modelRegistry: {
        getProviderAuth: async (provider) =>
          provider === "anthropic" && token !== undefined
            ? { auth: { apiKey: token }, source: "OAuth" }
            : undefined,
      },
    });

    await host.runCommand("usage", "", ctx);
    expect(host.getStatus("usage")).toMatch(/^Claude 5h .* 12%$/u);
    token = "replacement-login";
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toMatch(/^Claude 5h .* 34%$/u);
    });
    token = undefined;
    await host.runCommand("usage", "", ctx);
    expect(host.getStatus("usage")).toBe("Claude usage unavailable");
    expect(host.getNotifications().at(-1)?.message).toBe(
      "usage: anthropic: not logged in"
    );
    expect(authorizations).toStrictEqual([
      "Bearer initial-login",
      "Bearer replacement-login",
    ]);
    await host.emitSessionShutdown(ctx);
  });

  it("does not send a Radius credential without an unambiguous gateway", async () => {
    const { extension, fetchJson } = stubDependencies({ value: 1000 }, null);
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
    const { extension, fetchJson } = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: claudeModel });
    const context = host.createContext({ mode: "rpc", model: claudeModel });

    await host.emitSessionStart(context);
    await host.emit("agent_settled", { type: "agent_settled" }, context);

    expect(fetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("does not let a stale command refresh overwrite a model switch", async () => {
    const { extension, fetchJson } = stubDependencies({ value: 1000 });

    const radius = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();

    const claude = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();

    fetchJson.mockImplementation(async (url, schema, headers) => {
      if (url.includes("/v1/billing")) {
        const { json } = await radius.promise;

        return await okFetch(json)(url, schema, headers);
      }

      if (url.includes("anthropic.com")) {
        const { json } = await claude.promise;

        return await okFetch(json)(url, schema, headers);
      }

      return { message: "unavailable", ok: false };
    });
    const host = createExtensionHost(extension, { model: radiusModel });
    const radiusContext = host.createContext({ model: radiusModel });

    const command = host.runCommand("usage", "", radiusContext);
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.any(Object)
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
      claudeContext
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
    const { extension, fetchJson } = stubDependencies(nowRef);
    let requests = 0;
    fetchJson.mockImplementation(async (url, schema, headers) => {
      requests += 1;

      if (requests === 2) {
        return await successfulFetchJson(url, schema, headers);
      }

      return { message: "boom\n[31mred", ok: false };
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
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66%$/u);
    });

    nowRef.value = 61_000;
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await vi.waitFor(() => {
      expect(requests).toBe(3);
      expect(host.getStatus("usage")).toMatch(/^Claude week .* 66% !$/u);
    });

    expect(vi.mocked(context.ui.setStatus).mock.calls[0]).toStrictEqual([
      "usage",
      "Claude usage loading",
    ]);

    await host.emitSessionShutdown(context);
  });
});
