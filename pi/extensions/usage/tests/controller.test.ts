import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { ProviderAuthClient } from "../auth.js";
import { providerAuthClientFromContext } from "../auth.js";
import type { FetchJson } from "../http.js";
import { defaultFetchJson } from "../http.js";
import extension from "../index.js";

vi.mock(import("../auth.js"), { spy: true });
vi.mock(import("../http.js"), { spy: true });

const FOOTER_READY_EVENT = "clanker-footer:ready";
const FOOTER_WIDGET_EVENT = "clanker-footer:widget";

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
    host.events.emit(FOOTER_READY_EVENT, {
      instanceId: "host-1",
      protocol: 1,
      type: "ready",
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

  it("does not fetch usage automatically outside TUI mode", async () => {
    stubDependencies({ value: 1000 });
    const host = createExtensionHost(extension, { model: codexModel });
    const context = host.createContext({ mode: "rpc", model: codexModel });

    await host.emitSessionStart(context);
    await host.emit("agent_settled", { type: "agent_settled" }, context);

    expect(defaultFetchJson).not.toHaveBeenCalled();
    await host.emitSessionShutdown(context);
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
    host.events.emit(FOOTER_READY_EVENT, {
      instanceId: "host-1",
      protocol: 1,
      type: "ready",
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
