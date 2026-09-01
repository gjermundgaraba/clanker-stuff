import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  parseFooterWidgetMessage,
} from "@clanker-stuff/footer-protocol";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCodexRuntime } from "../../codex-provider/runtime.js";
import type { ProviderAuthClient } from "../auth.js";
import type { FetchJson } from "../http.js";
import { createUsageExtension } from "../index.js";

const makeJwt = (): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    }),
  ).toString("base64url");
  return `${header}.${body}.sig`;
};

const codexModel: Model<Api> = {
  api: "test",
  baseUrl: "",
  contextWindow: 200_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "gpt-5",
  input: ["text"],
  maxTokens: 16_000,
  name: "gpt-5",
  provider: "openai-codex",
  reasoning: true,
};
const claudeModel: Model<Api> = {
  ...codexModel,
  id: "claude-sonnet",
  name: "Claude Sonnet",
  provider: "anthropic",
};

const authClient: ProviderAuthClient = {
  getProviderAuth: async () => ({
    auth: { apiKey: makeJwt() },
    source: "OAuth",
  }),
};

const successfulFetchJson: FetchJson = async () => ({
  json: {
    rate_limit: {
      primary_window: { used_percent: 32 },
      secondary_window: { used_percent: 66 },
    },
  },
  ok: true,
});

const fetchJson = vi.fn<FetchJson>(successfulFetchJson);

const publishModels: RefreshModelsContext["publish"] = () => Promise.resolve(true);

const stubDependencies = (nowRef: { value: number }) => {
  fetchJson.mockReset();
  fetchJson.mockImplementation(successfulFetchJson);
  return createUsageExtension({
    fetchJson,
    now: () => nowRef.value,
    providerAuthClient: () => authClient,
  });
};

describe("usage controller", () => {
  it("keeps a native fallback and publishes rich snapshots when a host is ready", async () => {
    const extension = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const messages: object[] = [];
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      if (value instanceof Object) {
        messages.push(value);
      }
    });
    host.events.on(FOOTER_READY_REQUEST_EVENT, () => {
      host.events.emit(FOOTER_READY_EVENT, {
        instanceId: "host-1",
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready",
      });
    });

    const context = host.createContext({ model: codexModel });
    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("Codex");
    });
    expect(host.getStatus("usage")).toContain("66%");
    expect(
      messages.some(
        (message) =>
          "widget" in message &&
          message.widget instanceof Object &&
          "id" in message.widget &&
          message.widget.id === "clanker.usage.active",
      ),
    ).toBeTruthy();
    expect(
      messages.some(
        (message) =>
          "widget" in message &&
          message.widget instanceof Object &&
          "id" in message.widget &&
          message.widget.id === "clanker.usage.details",
      ),
    ).toBeTruthy();

    await host.emitSessionShutdown(context);
    expect(host.getStatus("usage")).toBeUndefined();
    expect(
      messages.filter((message) => "type" in message && message.type === "remove"),
    ).toHaveLength(2);
  });

  it("works without a rich footer host", async () => {
    const extension = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ model: codexModel });
    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("Codex");
    });
    await host.emitSessionShutdown(context);
  });

  it("refreshes immediately when Codex observes a login", async () => {
    const extension = stubDependencies({ value: 1000 });
    let requests = 0;
    let refreshModels:
      | ReturnType<typeof createCodexRuntime>["catalog"]["refreshModels"]
      | undefined;
    fetchJson.mockImplementation(async () => {
      requests += 1;
      return {
        json: {
          rate_limit: { primary_window: { used_percent: requests * 10 } },
        },
        ok: true,
      };
    });
    const host = createExtensionHost(
      (pi) => {
        ({ refreshModels } = createCodexRuntime(pi, vi.fn()).catalog);
        extension(pi);
      },
      { model: codexModel },
    );
    const context = host.createContext({ model: codexModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("10%");
    });
    if (refreshModels === undefined) {
      throw new Error("Codex model refresh was not registered");
    }
    const { signal } = new AbortController();
    await refreshModels({
      allowNetwork: false,
      publish: publishModels,
      signal,
    });
    await refreshModels({
      allowNetwork: false,
      credential: { key: makeJwt(), type: "api_key" },
      publish: publishModels,
      signal,
    });
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("20%");
    });

    expect(requests).toBe(2);
    await host.emitSessionShutdown(context);
  });

  it("does not fetch usage automatically outside TUI mode", async () => {
    const extension = stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ mode: "rpc", model: codexModel });

    await host.emitSessionStart(context);
    await host.emit("agent_settled", { type: "agent_settled" }, context);

    expect(fetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("does not let a stale command refresh overwrite a model switch", async () => {
    const extension = stubDependencies({ value: 1000 });
    const codex = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();
    const claude = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();
    fetchJson.mockImplementation(async (url) => {
      if (url.includes("/wham/usage")) {
        return await codex.promise;
      }
      if (url.includes("anthropic.com")) {
        return await claude.promise;
      }
      return { message: "unavailable", ok: false };
    });
    const host = createExtensionHost(extension, { model: codexModel });
    const codexContext = host.createContext({ model: codexModel });

    const command = host.runCommand("usage", "", codexContext);
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
    });
    const claudeContext = host.createContext({ model: claudeModel });
    await host.emit(
      "model_select",
      {
        model: claudeModel,
        previousModel: codexModel,
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

    codex.resolve({
      json: {
        rate_limit: {
          primary_window: { used_percent: 90 },
        },
      },
      ok: true,
    });
    await command;

    expect(host.getStatus("usage")).toContain("Claude");
    await host.emitSessionShutdown(claudeContext);
  });

  it("invalidates cached and in-flight Codex usage when the account changes", async () => {
    const extension = stubDependencies({ value: 1000 });
    const first = Promise.withResolvers<{ json: unknown; ok: true }>();
    const second = Promise.withResolvers<{ json: unknown; ok: true }>();
    let request = 0;
    fetchJson.mockImplementation(async () => {
      request += 1;
      return await (request === 1 ? first.promise : second.promise);
    });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ model: codexModel });
    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledOnce();
    });

    host.events.emit("clanker-codex:account-changed", null);
    await vi.waitFor(() => {
      expect(fetchJson).toHaveBeenCalledTimes(2);
    });
    first.resolve({
      json: {
        rate_limit: { primary_window: { used_percent: 11 } },
      },
      ok: true,
    });
    await Promise.resolve();
    expect(host.getStatus("usage")).not.toContain("11%");

    second.resolve({
      json: {
        rate_limit: { primary_window: { used_percent: 77 } },
      },
      ok: true,
    });
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("77%");
    });
    await host.emitSessionShutdown(context);
  });

  it("publishes loading, error, ready, and stale health", async () => {
    const nowRef = { value: 1000 };
    const extension = stubDependencies(nowRef);
    let requests = 0;
    const health: { message?: string; state: string }[] = [];
    fetchJson.mockImplementation(async (url, options) => {
      requests += 1;
      if (requests === 2) {
        return successfulFetchJson(url, options);
      }
      return { message: "boom\n[31mred", ok: false };
    });
    const host = createExtensionHost(extension, { model: codexModel });
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      const message = parseFooterWidgetMessage(value);
      if (
        message?.type === "upsert" &&
        message.widget.id === "clanker.usage.active" &&
        message.widget.health !== undefined
      ) {
        const widgetHealth = message.widget.health;
        health.push(
          widgetHealth.message === undefined
            ? { state: widgetHealth.state }
            : { message: widgetHealth.message, state: widgetHealth.state },
        );
      }
    });
    host.events.on(FOOTER_READY_REQUEST_EVENT, () => {
      host.events.emit(FOOTER_READY_EVENT, {
        instanceId: "host-1",
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready",
      });
    });
    const context = host.createContext({ model: codexModel });

    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(requests).toBe(1);
      expect(host.getStatus("usage")).toBe("usage unavailable");
    });
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await vi.waitFor(() => {
      expect(requests).toBe(2);
      expect(host.getStatus("usage")).toContain("66%");
    });

    nowRef.value = 61_000;
    await host.emit("agent_settled", { type: "agent_settled" }, context);
    await vi.waitFor(() => {
      expect(requests).toBe(3);
      expect(host.getStatus("usage")).toContain("!");
    });

    expect(health.map(({ state }) => state)).toStrictEqual(
      expect.arrayContaining(["loading", "error", "ready", "stale"]),
    );
    expect(health.at(-1)?.message).toBe("boom  [31mred");

    await host.emitSessionShutdown(context);
  });
});
