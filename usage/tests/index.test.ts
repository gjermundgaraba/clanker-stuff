import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import type { CodexBarDiscover } from "../adapters/opencode.js";
import type { ProviderAuthClient } from "../auth.js";
import type { FetchJson } from "../http.js";
import { createUsageExtension } from "../index.js";

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

const missingCodexBar: CodexBarDiscover = () =>
  Promise.resolve(process.env.PI_TEST_MISSING_CODEXBAR);

describe("usage contributor", () => {
  it("keeps a native fallback and publishes rich snapshots when a host is ready", async () => {
    const host = createExtensionHost(
      createUsageExtension({
        authClientFromContext: () => authClient,
        discoverCodexBar: missingCodexBar,
        fetchJson,
        now: () => 1000,
      }),
      { model: codexModel }
    );
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
    const host = createExtensionHost(
      createUsageExtension({
        authClientFromContext: () => authClient,
        discoverCodexBar: missingCodexBar,
        fetchJson,
      }),
      { model: codexModel }
    );
    await host.emitSessionStart(host.createContext({ model: codexModel }));
    await vi.waitFor(() => {
      expect(host.getStatus("usage")).toContain("Codex");
    });
  });

  it("publishes loading, error, ready, and stale health", async () => {
    let now = 1000;
    let requests = 0;
    const health: { message?: string; state: string }[] = [];
    const dynamicFetch: FetchJson = async () => {
      requests += 1;
      if (requests === 2) {
        return await fetchJson("", { timeoutMs: 1 });
      }
      return { message: "boom\n\u001B[31mred", ok: false };
    };
    const host = createExtensionHost(
      createUsageExtension({
        authClientFromContext: () => authClient,
        discoverCodexBar: missingCodexBar,
        fetchJson: dynamicFetch,
        now: () => now,
      }),
      { model: codexModel }
    );
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

    now = 61_000;
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
