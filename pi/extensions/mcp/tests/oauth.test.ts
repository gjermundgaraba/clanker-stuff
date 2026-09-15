import { oauthStatePath } from "../oauth-store.js";
import { connectToServer } from "../connection.js";
import { toGeneratedToolName } from "../bridge.js";
import { syncBuiltinESMExports } from "node:module";
import childProcess, { ChildProcess } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { z } from "zod/v4";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import mcp from "../index.js";
import { PersistentMcpOAuthProvider, startOAuthCallbackServer } from "../oauth.js";
import { FIXTURE_ACCESS_TOKEN } from "./fixtures/http-server.js";
import { setupMcpTest } from "./helpers.js";

const listeningPort = (server: Server): number => {
  return z.object({ port: z.number() }).parse(server.address()).port;
};

const availablePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "localhost");
  await once(server, "listening");
  const port = listeningPort(server);
  server.close();
  await once(server, "close");
  return port;
};

describe("mcp oauth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  const t = setupMcpTest();

  it.each([
    ["tui", false, false],
    ["tui", true, false],
    ["rpc", false, false],
    ["tui", false, true],
    ["rpc", false, true],
  ] as const)(
    "completes OAuth in %s mode (browser failure: %s, manager: %s)",
    async (mode, browserFails, viaManager) => {
      const fixture = await t.startHttpFixture({ oauth: true });
      const callbackPort = await availablePort();
      await t.writeConfig({
        mcpServers: {
          remote: {
            oauth: { callbackPort, scopes: "tools custom tools" },
            type: "http",
            url: fixture.url,
          },
        },
      });
      const select = vi.fn<() => Promise<string>>(async () =>
        viaManager ? "○ mcp-manager" : "○ remote",
      );
      const authorization = Promise.withResolvers<Response>();
      const spawn = vi.spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
        const child = new ChildProcess();
        if (browserFails) {
          queueMicrotask(() => child.emit("error", new Error("Browser launcher unavailable")));
        } else {
          const url = z.array(z.string()).parse(args).at(-1);
          if (url === undefined) throw new Error("Missing browser URL");
          // Following the redirect immediately also proves the callback listener is ready.
          void fetch(url).then(authorization.resolve, authorization.reject);
        }
        return child;
      });
      syncBuiltinESMExports();
      const notify = vi.fn<(message: string) => void>((message) => {
        if (!message.startsWith("Authorize MCP server remote:")) {
          return;
        }
        const [, url] = message.split("\n");
        if (url === undefined) {
          authorization.reject(new Error("OAuth authorization URL was not shown"));
          return;
        }
        expect(new URL(url).searchParams.get("scope")).toBe("tools custom");
        if (mode !== "tui" || browserFails) {
          void fetch(url).then(authorization.resolve, authorization.reject);
        }
      });
      const host = t.createExtensionHost(mcp, { hasUI: mode === "tui" || mode === "rpc" });
      const ctx = host.createContext({
        mode,
        ui: { custom: createCustomUiDriver().custom, notify, select },
      });

      if (viaManager) await host.runCommand("mcp", "", ctx);
      const loading = viaManager
        ? host.runTool("mcp_connect", { name: "remote" }, { ctx })
        : host.runCommand("mcp", "", ctx);
      await expect(authorization.promise).resolves.toMatchObject({ ok: true });
      await loading;

      expect(spawn).toHaveBeenCalledTimes(mode === "tui" ? 1 : 0);
      expect(notify).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Authorize MCP server remote:\nhttps?:\/\/.+\nWaiting for OAuth authorization\.\.\.$/u,
        ),
        "info",
      );

      const result = await host.runTool(toGeneratedToolName("remote", "search"), {
        query: "oauth-needle",
      });
      expect(result.content).toContainEqual({
        text: "result: oauth-needle",
        type: "text",
      });
      expect(
        JSON.parse(
          await readFile(
            oauthStatePath({
              type: "http",
              url: fixture.url,
              oauth: { callbackPort, scopes: "tools custom tools" },
            }),
            "utf-8",
          ),
        ),
      ).toMatchObject({
        clientInformation: { client_id: "fixture-client-id" },
        tokens: { access_token: FIXTURE_ACCESS_TOKEN },
      });
    },
  );

  it("does not open a browser when restoring a TUI session that needs authorization", async () => {
    const fixture = await t.startHttpFixture({ oauth: true });
    await t.writeConfig({
      mcpServers: { remote: { oauth: {}, type: "http", url: fixture.url } },
    });
    const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(new ChildProcess());
    syncBuiltinESMExports();
    const host = t.createExtensionHost(mcp, {
      hasUI: true,
      entries: [
        {
          type: "custom",
          customType: "mcp-server-loaded",
          data: { serverName: "remote" },
          id: "loaded",
          parentId: null,
          timestamp: new Date().toISOString(),
        },
      ],
      leafId: "loaded",
    });

    await host.emitSessionStart();

    expect(spawn).not.toHaveBeenCalled();
    expect(host.getNotifications()).toContainEqual(expect.objectContaining({ type: "warning" }));
    expect(host.getRegisteredTools().size).toBe(0);
  });

  it("uses an OS-assigned callback port by default", async () => {
    const fixture = await t.startHttpFixture({ oauth: true });
    let browser: Promise<Response> | undefined;
    const connection = await connectToServer({
      serverConfig: { type: "http", url: fixture.url, oauth: {} },
      onAuthorizationUrl: (url) => {
        browser = fetch(url);
      },
    });
    try {
      expect((await browser)?.ok).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("reuses valid access-only tokens without authorization or discovery", async () => {
    const fixture = await t.startHttpFixture({ oauth: true });
    const config = { type: "http" as const, url: fixture.url, oauth: {} };
    const provider = new PersistentMcpOAuthProvider(config);
    await provider.saveTokens({ access_token: FIXTURE_ACCESS_TOKEN, token_type: "Bearer" });
    const notify = vi.fn();
    const connection = await connectToServer({ serverConfig: config, onAuthorizationUrl: notify });
    try {
      expect(notify).not.toHaveBeenCalled();
      expect((await connection.client.listTools()).tools).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it("serializes rotating refresh tokens across connections", async () => {
    const fixture = await t.startHttpFixture({ oauth: true });
    const config = {
      type: "http" as const,
      url: fixture.url,
      oauth: { clientId: "fixture-client-id" },
    };
    const provider = new PersistentMcpOAuthProvider(config);
    await provider.saveTokens({
      access_token: FIXTURE_ACCESS_TOKEN,
      refresh_token: "fixture-refresh-token",
      token_type: "Bearer",
    });
    const connections = await Promise.all(
      Array.from({ length: 2 }, () => connectToServer({ serverConfig: config })),
    );
    try {
      fixture.expireAccessToken();
      const results = await Promise.all(
        connections.map((connection) =>
          connection.client.callTool({ name: "search", arguments: { query: "refresh" } }),
        ),
      );
      expect(results).toHaveLength(2);
      expect(fixture.getRefreshCount()).toBe(1);
      expect(await provider.tokens()).toMatchObject({ refresh_token: "rotated-1" });
    } finally {
      await Promise.all(connections.map((connection) => connection.close()));
    }
  });

  it("refreshes OAuth and recovers an expired session during idle heartbeats without prompting", async () => {
    const fixture = await t.startHttpFixture({ oauth: true, scenario: "expired-ping" });
    const config = {
      type: "http" as const,
      url: fixture.url,
      oauth: { clientId: "fixture-client-id" },
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_000,
    };
    const provider = new PersistentMcpOAuthProvider(config);
    await provider.saveTokens({
      access_token: FIXTURE_ACCESS_TOKEN,
      refresh_token: "fixture-refresh-token",
      token_type: "Bearer",
    });
    expect(oauthStatePath(config)).toBe(oauthStatePath({ ...config, heartbeatIntervalMs: 0 }));
    await t.writeConfig({ mcpServers: { remote: config } });
    const host = t.createExtensionHost(mcp, { hasUI: false });
    await host.runCommand(
      "mcp",
      "",
      host.createContext({ ui: { select: async () => "○ remote" } }),
    );
    const name = toGeneratedToolName("remote", "search");
    expect(host.getActiveTools()).toContain(name);
    fixture.expireAccessToken();
    await expect.poll(fixture.getInitializationCount).toBe(2);
    await expect.poll(() => host.getActiveTools()).toContain(name);
    expect(fixture.getRefreshCount()).toBe(1);
    expect(fixture.getToolCallCount()).toBe(0);
    expect(
      host.getNotifications().some(({ message }) => message.includes("Authorize MCP server")),
    ).toBe(false);
    expect(
      host
        .getAppendedEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "mcp-server-loaded"),
    ).toHaveLength(1);
    const result = await host.runTool(name, { query: "after-idle-recovery" });
    expect(result.content).toContainEqual({ type: "text", text: "result: after-idle-recovery" });
  });

  it.each(["expired", "scope", "refreshed"])(
    "deactivates %s authorization and recovers through explicit reconnect",
    async (reason) => {
      const fixture = await t.startHttpFixture({ oauth: true });
      const config = {
        type: "http" as const,
        url: fixture.url,
        oauth: { clientId: "fixture-client-id", scopes: "tools custom" },
      };
      await new PersistentMcpOAuthProvider(config).saveTokens({
        access_token: FIXTURE_ACCESS_TOKEN,
        refresh_token: "fixture-refresh-token",
        token_type: "Bearer",
      });
      await t.writeConfig({ mcpServers: { remote: config } });
      const host = t.createExtensionHost(mcp, { hasUI: true });
      const notify = vi.fn((message: string) => {
        if (message.startsWith("Authorize MCP server remote:")) {
          const url = message.split("\n")[1];
          if (!url) throw new Error("Missing authorization URL");
          expect(new URL(url).searchParams.get("scope")).toBe(
            reason === "scope" ? "tools custom extra" : "tools custom",
          );
          void fetch(url);
        }
      });
      const ctx = host.createContext({
        mode: "rpc",
        ui: { notify, select: async () => "○ remote" },
      });
      await host.runCommand("mcp", "", ctx);
      const name = toGeneratedToolName("remote", "search");
      if (reason === "expired") {
        fixture.expireAccessToken();
        fixture.rejectRefresh();
      } else if (reason === "refreshed") {
        fixture.expireAccessToken();
        fixture.returnInvalidRefreshedToken();
      } else fixture.requireMoreScope();
      await expect(host.runTool(name, { query: "expired" }, { ctx })).rejects.toThrow(
        "requires authorization",
      );
      expect(host.getActiveTools()).not.toContain(name);
      expect(notify.mock.calls.some(([message]) => message.startsWith("Authorize MCP"))).toBe(
        false,
      );
      await host.runCommand("mcp", "", ctx);
      expect(host.getActiveTools()).toContain(name);
      const result = await host.runTool(name, { query: "again" }, { ctx });
      expect(result.content).toContainEqual({ type: "text", text: "result: again" });
    },
  );

  it("pins registration and issuer during overlapping browser handshakes", async () => {
    const config = { type: "http" as const, url: "https://a.example/mcp", oauth: {} };
    const first = new PersistentMcpOAuthProvider(config);
    const second = new PersistentMcpOAuthProvider(config);
    await first.saveClientInformation({ client_id: "first" });
    await first.saveDiscoveryState({ authorizationServerUrl: "https://original.example" });
    await first.saveCodeVerifier("first-verifier");
    await second.saveClientInformation({ client_id: "second" });
    await second.saveDiscoveryState({ authorizationServerUrl: "https://changed.example" });
    expect(await first.clientInformation()).toEqual({ client_id: "first" });
    expect(await first.discoveryState()).toEqual({
      authorizationServerUrl: "https://original.example",
    });
    await first.saveTokens({ access_token: "first-token", token_type: "Bearer" });
    expect(await second.clientInformation()).toEqual({ client_id: "first" });
  });

  it("isolates endpoint/client/scope credentials and keeps handshakes local", async () => {
    const config = {
      type: "http" as const,
      url: "https://a.example/mcp",
      oauth: { clientId: "a" },
    };
    const first = new PersistentMcpOAuthProvider(config);
    const same = new PersistentMcpOAuthProvider(config);
    await first.saveTokens({
      access_token: "secret",
      token_type: "Bearer",
      issuer: "https://issuer.example",
    });
    await first.saveCodeVerifier("private-verifier");
    expect(() => same.codeVerifier()).toThrow("No MCP OAuth code verifier");
    expect(await same.tokens()).toMatchObject({
      access_token: "secret",
      issuer: "https://issuer.example",
    });
    for (const other of [
      { ...config, url: "https://b.example/mcp" },
      { ...config, oauth: { clientId: "b" } },
      { ...config, headers: { "X-Tenant": "other" } },
      { ...config, oauth: { clientId: "a", scopes: "other" } },
      { ...config, oauth: { clientId: "a", clientSecret: "other" } },
      { ...config, oauth: { clientId: "a", callbackPort: 33418 } },
      {
        ...config,
        oauth: { clientId: "a", authServerMetadataUrl: "https://other.example/metadata" },
      },
    ]) {
      expect(await new PersistentMcpOAuthProvider(other).tokens()).toBeUndefined();
    }
    expect(
      await new PersistentMcpOAuthProvider({
        ...config,
        oauth: { ...config.oauth, clientName: "New display name" },
      }).tokens(),
    ).toEqual(await first.tokens());
    const raw = await readFile(first.statePath, "utf-8");
    expect(raw).not.toContain("private-verifier");
    if (process.platform !== "win32")
      expect((await stat(first.statePath)).mode & 0o777).toBe(0o600);
    await first.invalidateCredentials("all");
    expect(await first.tokens()).toBeUndefined();
    expect(await first.clientInformation()).toMatchObject({ client_id: "a" });
  });

  it("isolates malformed credential files", async () => {
    const first = new PersistentMcpOAuthProvider({ type: "http", url: "https://a.example" });
    await first.saveTokens({ access_token: "a", token_type: "Bearer" });
    await writeFile(first.statePath, "not json");
    await expect(first.tokens()).rejects.toThrow("Cannot read MCP OAuth credentials");
    const second = new PersistentMcpOAuthProvider({ type: "http", url: "https://b.example" });
    expect(await second.tokens()).toBeUndefined();
  });

  it("ignores incorrect callback state, preserves issuer, and removes the listener", async () => {
    const callback = await startOAuthCallbackServer(
      new URL("http://localhost:0/callback"),
      "expected",
    );
    try {
      expect(
        (await fetch(`${callback.redirectUrl.href}?state=wrong&error=access_denied`)).status,
      ).toBe(400);
      const wait = callback.waitForCode();
      await fetch(
        `${callback.redirectUrl.href}?state=expected&code=ok&iss=https%3A%2F%2Fissuer.example`,
      );
      expect(await wait).toEqual({ code: "ok", iss: "https://issuer.example" });
    } finally {
      await callback.close();
    }
    await expect(fetch(callback.redirectUrl)).rejects.toThrow();
  });

  it("cancels callback waiting promptly", async () => {
    const callback = await startOAuthCallbackServer(
      new URL("http://localhost:0/callback"),
      "expected",
    );
    try {
      const controller = new AbortController();
      const waiting = callback.waitForCode(controller.signal);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await callback.close();
    }
  });

  it.each(["before", "during"])(
    "preserves other callback waiters when cancellation occurs %s waiting",
    async (when) => {
      const callback = await startOAuthCallbackServer(
        new URL("http://localhost:0/callback"),
        "expected",
      );
      try {
        const controller = new AbortController();
        const reason = new Error("Caller stopped waiting");
        const other = new AbortController();
        const remaining = callback.waitForCode(other.signal);
        if (when === "before") controller.abort(reason);
        const cancelled = callback.waitForCode(controller.signal);
        if (when === "during") controller.abort(reason);

        await expect(cancelled).rejects.toBe(reason);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        await fetch(`${callback.redirectUrl.href}?state=expected&code=ok`);
        await expect(remaining).resolves.toEqual({ code: "ok", iss: undefined });
        expect(getEventListeners(other.signal, "abort")).toHaveLength(0);
        await expect(callback.waitForCode()).resolves.toEqual({ code: "ok", iss: undefined });
      } finally {
        await callback.close();
      }
    },
  );

  it("cancels a stalled OAuth metadata request", async () => {
    const fixture = await t.startHttpFixture({ oauth: true });
    const server = createServer((req) => req.resume());
    server.listen(0, "localhost");
    await once(server, "listening");
    const controller = new AbortController();
    const requested = once(server, "request");
    const connection = connectToServer({
      serverConfig: {
        type: "http",
        url: fixture.url,
        oauth: { authServerMetadataUrl: `http://localhost:${listeningPort(server)}` },
      },
      signal: controller.signal,
      onAuthorizationUrl: () => {},
    });
    const rejected = expect(connection).rejects.toMatchObject({ name: "AbortError" });
    try {
      await requested;
      controller.abort();
      await rejected;
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  });
});
