import type { AuthResult } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { contextAuth, resolveUsageCredential } from "../auth.js";
import type { GetAuth } from "../auth.js";

const auth =
  (apiKey: string, source: string): GetAuth =>
  async () => ({ auth: { apiKey }, source });

describe(contextAuth, () => {
  it("uses the stored GitHub OAuth token for Copilot and Pi's auth otherwise", async () => {
    const getProviderAuth = vi
      .fn<(provider: string) => Promise<AuthResult | undefined>>()
      .mockResolvedValue({
        auth: { apiKey: "registry-token" },
        source: "OAuth",
      });

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
    await expect(getAuth("zai")).resolves.toMatchObject({
      auth: { apiKey: "registry-token" },
    });
  });
});

describe(resolveUsageCredential, () => {
  it.each([
    ["ANTHROPIC_API_KEY", false],
    ["OAuth", true],
  ] as const)(
    "preserves whether the resolved token is OAuth (%s)",
    async (source, oauth) => {
      await expect(
        resolveUsageCredential(auth("token", source), "anthropic")
      ).resolves.toStrictEqual({
        ok: true,
        credential: { token: "token", oauth },
      });
    }
  );

  it.each([
    ["missing", async () => {}],
    ["empty", auth("", "ANTHROPIC_API_KEY")],
    [
      "failing",
      async () => {
        throw new Error("refresh failed");
      },
    ],
  ] satisfies Array<[string, GetAuth]>)(
    "reports %s auth as not logged in",
    async (_name, getAuth) => {
      await expect(
        resolveUsageCredential(getAuth, "kimi-coding")
      ).resolves.toStrictEqual({
        error: { kind: "unavailable", message: "not logged in" },
        ok: false,
      });
    }
  );
});
