import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import mcp from "../index.js";
import {
  PersistentMcpOAuthProvider,
  startOAuthCallbackServer,
} from "../oauth.js";
import { FIXTURE_ACCESS_TOKEN } from "./fixtures/http-server.js";
import { setupMcpTest } from "./helpers.js";

describe("mcp oauth", () => {
  const t = setupMcpTest();

  it("completes OAuth after the user follows the displayed URL", async () => {
    const fixture = await t.startHttpFixture(true);
    await t.writeConfig({
      mcpServers: {
        remote: {
          oauth: { callbackPort: 33_420 },
          type: "http",
          url: fixture.url,
        },
      },
    });
    const select = vi.fn<() => Promise<string>>(async () => "remote");
    const host = t.createExtensionHost(mcp, { hasUI: false });
    const ctx = host.createContext({ ui: { select } });

    const loading = host.runCommand("mcp", "", ctx);
    const authorizationUrl = await vi.waitFor(() => {
      const message = host.getNotifications().at(-1)?.message;
      if (message === undefined) {
        throw new Error("OAuth authorization URL was not shown");
      }
      expect(message).toMatch(
        /^Authorize MCP server remote:\nhttps?:\/\/.+\nWaiting for OAuth authorization\.\.\.$/u
      );
      return message.split("\n")[1];
    });
    await fetch(authorizationUrl);
    await loading;

    const result = await host.runTool("mcp_remote__search", {
      query: "oauth-needle",
    });
    expect(result.content).toContainEqual({
      text: "result: oauth-needle",
      type: "text",
    });
    expect(
      JSON.parse(
        await readFile(path.join(t.configDir, "mcp-oauth.json"), "utf-8")
      )
    ).toMatchObject({
      servers: {
        remote: {
          clientInformation: { client_id: "fixture-client-id" },
          tokens: { access_token: FIXTURE_ACCESS_TOKEN },
        },
      },
    });
  });

  describe(PersistentMcpOAuthProvider, () => {
    it("maps Claude-shaped OAuth config to the provider", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        {
          callbackPort: 33_419,
          clientId: "client-id",
          clientSecret: "client-secret",
          scopes: "tools resources",
        },
        vi.fn<() => void>()
      );

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "client-id",
        client_secret: "client-secret",
      });
      expect(provider.clientMetadata.scope).toBe("tools resources");
      expect(provider.redirectUrl.toString()).toBe(
        "http://localhost:33419/callback"
      );
    });

    it("persists dynamic client information and tokens per server", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      });

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
      });
      await expect(provider.tokens()).resolves.toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
      expect(
        JSON.parse(
          await readFile(path.join(t.configDir, "mcp-oauth.json"), "utf-8")
        )
      ).toMatchObject({
        servers: {
          remote: {
            clientInformation: { client_id: "dynamic-client" },
            tokens: { access_token: "access-token" },
          },
        },
      });
    });

    it("round-trips the SEP-2352 issuer stamp on stored credentials", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      // saveClientInformation then saveTokens mirrors the SDK auth flow; the
      // second save must not strip the issuer stamp from clientInformation.
      await provider.saveClientInformation({
        client_id: "dynamic-client",
        issuer: "https://auth.example.com",
      });
      await provider.saveTokens({
        access_token: "access-token",
        issuer: "https://auth.example.com",
        token_type: "Bearer",
      });

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
        issuer: "https://auth.example.com",
      });
      await expect(provider.tokens()).resolves.toStrictEqual({
        access_token: "access-token",
        issuer: "https://auth.example.com",
        token_type: "Bearer",
      });
    });

    it("clears only tokens on the tokens scope", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );
      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      });
      await provider.saveCodeVerifier("verifier");

      await provider.invalidateCredentials("tokens");

      await expect(provider.tokens()).resolves.toBeUndefined();
      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "dynamic-client",
      });
      await expect(provider.codeVerifier()).resolves.toBe("verifier");
    });

    it("clears all stored credentials on the all scope", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );
      await provider.saveClientInformation({ client_id: "dynamic-client" });
      await provider.saveTokens({
        access_token: "access-token",
        token_type: "Bearer",
      });
      await provider.saveCodeVerifier("verifier");
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
      });

      await provider.invalidateCredentials("all");

      await expect(provider.clientInformation()).resolves.toBeUndefined();
      await expect(provider.tokens()).resolves.toBeUndefined();
      await expect(provider.codeVerifier()).rejects.toThrow(
        "No MCP OAuth code verifier saved"
      );
      await expect(provider.discoveryState()).resolves.toBeUndefined();
    });

    it("keeps static-config client credentials on invalidation", async () => {
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { clientId: "static-client", scopes: "tools" },
        vi.fn<() => void>()
      );

      await provider.invalidateCredentials("all");

      await expect(provider.clientInformation()).resolves.toStrictEqual({
        client_id: "static-client",
        client_secret: undefined,
      });
    });

    it("rejects malformed persisted OAuth state", async () => {
      await mkdir(t.configDir, { recursive: true });
      await writeFile(
        path.join(t.configDir, "mcp-oauth.json"),
        '{"servers":null}\n',
        "utf-8"
      );
      const provider = new PersistentMcpOAuthProvider(
        "remote",
        { scopes: "tools" },
        vi.fn<() => void>()
      );

      await expect(provider.tokens()).rejects.toThrow(
        "invalid MCP OAuth state"
      );

      await writeFile(
        path.join(t.configDir, "mcp-oauth.json"),
        '{"servers":{"remote":{"tokens":{"access_token":42}}}}\n',
        "utf-8"
      );
      await expect(provider.tokens()).rejects.toThrow(
        "invalid MCP OAuth state"
      );
    });
  });

  describe(startOAuthCallbackServer, () => {
    it("rejects waitForCode when the abort signal fires", async () => {
      const server = await startOAuthCallbackServer(
        new URL("http://localhost:0/callback"),
        "expected-state"
      );
      try {
        const controller = new AbortController();
        const wait = server.waitForCode(controller.signal);
        controller.abort();
        await expect(wait).rejects.toThrow(
          "MCP OAuth authorization was cancelled"
        );
      } finally {
        await server.close();
      }
    });

    it("rejects cleanly when the callback port is already in use", async () => {
      const squatter = createServer();
      squatter.listen(0, "localhost");
      await once(squatter, "listening");
      const { port } = squatter.address() as { port: number };
      try {
        await expect(
          startOAuthCallbackServer(
            new URL(`http://localhost:${port}/callback`),
            "expected-state"
          )
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
      } finally {
        squatter.close();
        await once(squatter, "close");
      }
    });
  });
});
