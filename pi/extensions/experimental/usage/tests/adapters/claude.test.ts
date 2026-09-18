import { okFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchClaudeUsage, mapClaudeUsagePayload } from "../../adapters/claude.js";
import type { FetchJson } from "../../http.js";
import { NOW, tokenAuthClient } from "./helpers.js";

describe("claude usage", () => {
  const payload = {
    five_hour: {
      resets_at: "2026-07-21T14:00:00.000Z",
      utilization: 25,
    },
    seven_day: {
      resets_at: "2026-07-28T00:00:00.000Z",
      utilization: 50,
    },
  };

  it("maps five_hour and seven_day utilization", () => {
    const result = mapClaudeUsagePayload(payload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "anthropic",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 75,
            resetsAt: "2026-07-21T14:00:00.000Z",
          },
          {
            id: "week",
            label: "week",
            remainingPercent: 50,
            resetsAt: "2026-07-28T00:00:00.000Z",
          },
        ],
      },
    });
  });

  it("fails when a valid payload has no windows", () => {
    expect(mapClaudeUsagePayload({}, NOW)).toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "no usage windows in response" },
    });
  });

  it.each([-1, 101])("rejects out-of-range utilization %s at ingress", async (utilization) => {
    await expect(
      fetchClaudeUsage({
        authClient: tokenAuthClient("token"),
        fetchJson: okFetch({ five_hour: { utilization } }),
        now: () => NOW,
      }),
    ).resolves.toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "invalid usage payload" },
    });
  });

  it("requests OAuth usage with Anthropic headers", async () => {
    const client = { fetchJson: okFetch(payload) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    await fetchClaudeUsage({
      authClient: tokenAuthClient("claude-token"),
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    const [url, , options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(options?.headers?.Authorization).toBe("Bearer claude-token");
    expect(options?.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("does not treat an Anthropic API key as subscription OAuth", async () => {
    const client = { fetchJson: okFetch(undefined) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchClaudeUsage({
      authClient: {
        getProviderAuth: async () => ({
          auth: { apiKey: "api-key" },
          source: "Environment",
        }),
      },
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      error: {
        kind: "unavailable",
      },
      ok: false,
    });
    expect(result).toHaveProperty("error.message", expect.stringContaining("requires OAuth login"));
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
