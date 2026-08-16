import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
} from "@clanker-stuff/footer-protocol";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCodexRuntime } from "../../experimental/codex-provider/runtime.js";
import type { ProviderAuthClient } from "../auth.js";
import { providerAuthClientFromContext } from "../auth.js";
import type { FetchJson } from "../http.js";
import { defaultFetchJson } from "../http.js";
import extension from "../index.js";

vi.mock(import("../auth.js"), { spy: true });
vi.mock(import("../http.js"), { spy: true });

const makeJwt = (): string => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url"
  );
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    })
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

const fetchJson: FetchJson = async () => ({
  json: {
    rate_limit: {
      primary_window: { used_percent: 32 },
      secondary_window: { used_percent: 66 },
    },
  },
  ok: true,
});

const publishModels: RefreshModelsContext["publish"] = () =>
  Promise.resolve(true);

const stubDependencies = (nowRef: { value: number }) => {
  vi.mocked(providerAuthClientFromContext).mockReturnValue(authClient);
  vi.mocked(defaultFetchJson).mockImplementation(fetchJson);
  // oxlint-disable-next-line vitest/prefer-mock-return-shorthand -- time must be read lazily; tests advance nowRef mid-run
  vi.spyOn(Date, "now").mockImplementation(() => nowRef.value);
};

describe("usage controller", () => {
  it("keeps a native fallback and publishes rich snapshots when a host is ready", async () => {
    stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const messages: unknown[] = [];
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      messages.push(value);
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
          typeof message === "object" &&
          message !== null &&
          "widget" in message &&
          (message.widget as { id?: string }).id === "clanker.usage.active"
      )
    ).toBeTruthy();
    expect(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "widget" in message &&
          (message.widget as { id?: string }).id === "clanker.usage.details"
      )
    ).toBeTruthy();

    await host.emitSessionShutdown(context);
    expect(host.getStatus("usage")).toBeUndefined();
    expect(
      messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "remove"
      )
    ).toHaveLength(2);
  });

  it("works without a rich footer host", async () => {
    stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ model: codexModel });
    await host.emitSessionStart(context);
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("Codex");
    });
    await host.emitSessionShutdown(context);
  });

  it("refreshes immediately when Codex observes a login", async () => {
    stubDependencies({ value: 1000 });
    let requests = 0;
    let refreshModels:
      | ReturnType<typeof createCodexRuntime>["catalog"]["refreshModels"]
      | undefined;
    vi.mocked(defaultFetchJson).mockImplementation(async () => {
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
      { model: codexModel }
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
    stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ mode: "rpc", model: codexModel });

    await host.emitSessionStart(context);
    await host.emit("agent_settled", { type: "agent_settled" }, context);

    expect(defaultFetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
  });

  it("does not let a stale command refresh overwrite a model switch", async () => {
    stubDependencies({ value: 1000 });
    const codex = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();
    const claude = Promise.withResolvers<{
      json: unknown;
      ok: true;
    }>();
    vi.mocked(defaultFetchJson).mockImplementation(async (url) => {
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
      expect(defaultFetchJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object)
      );
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

  it("publishes loading, error, ready, and stale health", async () => {
    const nowRef = { value: 1000 };
    stubDependencies(nowRef);
    let requests = 0;
    const health: { message?: string; state: string }[] = [];
    vi.mocked(defaultFetchJson).mockImplementation(async (url, options) => {
      requests += 1;
      if (requests === 2) {
        return fetchJson(url, options);
      }
      return { message: "boom\n[31mred", ok: false };
    });
    const host = createExtensionHost(extension, { model: codexModel });
    host.events.on(FOOTER_WIDGET_EVENT, (value) => {
      const { widget } = value as {
        widget?: {
          health?: { message?: string; state?: string };
          id?: string;
        };
      };
      if (
        widget?.id === "clanker.usage.active" &&
        widget.health?.state !== undefined
      ) {
        health.push({
          ...(widget.health.message === undefined
            ? {}
            : { message: widget.health.message }),
          state: widget.health.state,
        });
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
      expect.arrayContaining(["loading", "error", "ready", "stale"])
    );
    expect(health.at(-1)?.message).toBe("boom  [31mred");

    await host.emitSessionShutdown(context);
  });
});
