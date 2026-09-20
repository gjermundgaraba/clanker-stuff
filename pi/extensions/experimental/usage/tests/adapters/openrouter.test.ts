import { describe, expect, it } from "vite-plus/test";

import { fetchOpenRouterUsage, mapOpenRouterCreditsPayload } from "../../adapters/openrouter.js";
import type { FetchJson } from "../../http.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

// Live shape returned by https://openrouter.ai/api/v1/credits.
const creditsPayload = {
  data: {
    total_credits: 25.5,
    total_usage: 12.75,
  },
};

describe("openrouter usage", () => {
  it("maps the credits payload to a credit balance", () => {
    expect(mapOpenRouterCreditsPayload(creditsPayload, NOW)).toStrictEqual({
      ok: true,
      snapshot: {
        accounting: { available: 12.75, kind: "credit-balance" },
        fetchedAt: NOW,
        provider: "openrouter",
        quotaWindows: [],
      },
    });
  });

  it("reports a negative balance when usage exceeds purchased credits", () => {
    expect(
      mapOpenRouterCreditsPayload({ data: { total_credits: 5, total_usage: 7.5 } }, NOW),
    ).toMatchObject({
      ok: true,
      snapshot: { accounting: { available: -2.5, kind: "credit-balance" } },
    });
  });

  it("requires login", async () => {
    const result = await fetchOpenRouterUsage({
      authClient: { getProviderAuth: async () => undefined },
      fetchJson: okFetch(creditsPayload),
      now: () => NOW,
    });

    expect(result).toStrictEqual({
      error: { kind: "unavailable", message: "not logged in" },
      ok: false,
    });
  });

  it("sends the API key as a bearer token", async () => {
    let seenAuthorization: string | undefined;
    let seenUrl: string | undefined;

    const fetchJson: FetchJson = async (url, schema, options) => {
      seenAuthorization = options.headers?.Authorization;
      seenUrl = url;

      return await okFetch(creditsPayload)(url, schema, options);
    };

    const result = await fetchOpenRouterUsage({
      authClient: tokenAuthClient("sk-or-test"),
      fetchJson,
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: true });
    expect({ authorization: seenAuthorization, url: seenUrl }).toStrictEqual({
      authorization: "Bearer sk-or-test",
      url: "https://openrouter.ai/api/v1/credits",
    });
  });

  it("propagates HTTP failures", async () => {
    const result = await fetchOpenRouterUsage({
      authClient: tokenAuthClient("sk-or-test"),
      fetchJson: async () => ({ kind: "response", message: "HTTP 401", ok: false, status: 401 }),
      now: () => NOW,
    });

    expect(result).toStrictEqual({
      error: { kind: "failure", message: "HTTP 401" },
      ok: false,
    });
  });

  it("fails on unexpected payloads", async () => {
    const result = await fetchOpenRouterUsage({
      authClient: tokenAuthClient("sk-or-test"),
      fetchJson: okFetch({ data: { total_credits: "nope" } }),
      now: () => NOW,
    });

    expect(result).toStrictEqual({
      error: { kind: "failure", message: "invalid usage payload" },
      ok: false,
    });
  });
});
