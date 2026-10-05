import type { AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { accessToken, contextAuth } from "../auth.js";
import type { GetAuth } from "../auth.js";

const auth =
  (apiKey: string, source: string): GetAuth =>
  async () => ({ auth: { apiKey }, source });

describe(contextAuth, () => {
  it("uses the stored GitHub OAuth token for Copilot and Pi's auth otherwise", async () => {
    const getProviderAuth = vi
      .fn<(provider: string) => Promise<AuthResult | undefined>>()
      .mockResolvedValue({ auth: { apiKey: "registry-token" }, source: "OAuth" });

    const getAuth = contextAuth({ modelRegistry: { getProviderAuth } }, () => ({
      access: "copilot-api-token",
      expires: Date.now() + 60_000,
      refresh: "github-oauth-token",
      type: "oauth",
    }));

    await expect(getAuth("github-copilot")).resolves.toStrictEqual({
      auth: { apiKey: "github-oauth-token" },
      source: "OAuth",
    });
    expect(getProviderAuth).not.toHaveBeenCalled();
    await expect(getAuth("zai")).resolves.toMatchObject({ auth: { apiKey: "registry-token" } });
  });
});

describe(accessToken, () => {
  it("returns the resolved token regardless of credential source", async () => {
    await expect(
      accessToken(auth("sk-ant-key", "ANTHROPIC_API_KEY"), "anthropic"),
    ).resolves.toStrictEqual({ ok: true, token: "sk-ant-key" });
  });

  it.each([
    ["missing", async () => undefined],
    [
      "failing",
      async () => {
        throw new Error("refresh failed");
      },
    ],
  ] satisfies [string, GetAuth][])("reports %s auth as not logged in", async (_name, getAuth) => {
    await expect(accessToken(getAuth, "kimi-coding")).resolves.toStrictEqual({
      error: { kind: "unavailable", message: "not logged in" },
      ok: false,
    });
  });

  it("requires OAuth for subscription usage", async () => {
    await expect(
      accessToken(auth("sk-test", "XAI_API_KEY"), "xai", { oauth: true }),
    ).resolves.toStrictEqual({
      error: {
        kind: "unavailable",
        message: "subscription usage requires OAuth login (not API key)",
      },
      ok: false,
    });
    await expect(
      accessToken(auth("access-token", "OAuth"), "xai", { oauth: true }),
    ).resolves.toStrictEqual({ ok: true, token: "access-token" });
  });
});
