import type { AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ProviderAuthClient } from "../auth.js";
import {
  providerAuthClientFromContext,
  resolveAccessToken,
  resolveOAuthAccess,
} from "../auth.js";
import { absent } from "./adapters/helpers.js";

describe("provider auth client", () => {
  it("uses the stored GitHub OAuth token for Copilot usage", async () => {
    const getProviderAuth = vi
      .fn<(provider: string) => Promise<AuthResult | undefined>>()
      .mockResolvedValue({
        auth: { apiKey: "copilot-api-token" },
        source: "OAuth",
      });
    const client = providerAuthClientFromContext(
      { modelRegistry: { getProviderAuth } },
      () => ({
        access: "copilot-api-token",
        expires: Date.now() + 60_000,
        refresh: "github-oauth-token",
        type: "oauth",
      })
    );

    await expect(
      client.getProviderAuth("github-copilot")
    ).resolves.toStrictEqual({
      auth: { apiKey: "github-oauth-token" },
      source: "OAuth",
    });
    expect(getProviderAuth).not.toHaveBeenCalled();
  });
});

describe("access token resolution", () => {
  it("returns the resolved token regardless of credential source", async () => {
    const client: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "sk-ant-key" },
        source: "ANTHROPIC_API_KEY",
      }),
    };

    await expect(
      resolveAccessToken(client, "anthropic")
    ).resolves.toStrictEqual({
      ok: true,
      value: { accessToken: "sk-ant-key" },
    });
  });

  it("reports not logged in when auth is missing", async () => {
    const client: ProviderAuthClient = { getProviderAuth: absent };

    await expect(resolveAccessToken(client, "minimax")).resolves.toStrictEqual({
      kind: "unavailable",
      message: "not logged in",
      ok: false,
    });
  });
});

describe("OAuth access resolution", () => {
  it("reports not logged in when auth is missing", async () => {
    const client: ProviderAuthClient = { getProviderAuth: absent };

    await expect(resolveOAuthAccess(client, "xai")).resolves.toStrictEqual({
      kind: "unavailable",
      message: "not logged in",
      ok: false,
    });
  });

  it("rejects non-OAuth credentials", async () => {
    const client: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "sk-test" },
        source: "XAI_API_KEY",
      }),
    };

    await expect(resolveOAuthAccess(client, "xai")).resolves.toStrictEqual({
      kind: "unavailable",
      message: "subscription usage requires OAuth login (not API key)",
      ok: false,
    });
  });

  it("returns an OAuth access token", async () => {
    const client: ProviderAuthClient = {
      getProviderAuth: async () => ({
        auth: { apiKey: "access-token" },
        source: "OAuth",
      }),
    };

    await expect(resolveOAuthAccess(client, "xai")).resolves.toStrictEqual({
      ok: true,
      value: { accessToken: "access-token" },
    });
  });
});
