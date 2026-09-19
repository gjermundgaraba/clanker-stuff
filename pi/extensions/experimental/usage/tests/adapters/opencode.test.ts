import { okFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchOpenCodeGoUsage, mapOpenCodeGoUsagePayload } from "../../adapters/opencode.js";
import type { FetchJson } from "../../http.js";
import { NOW, tokenAuthClient } from "./helpers.js";

describe("opencode go usage", () => {
  const payload = {
    usage: {
      monthly: {
        percent: 56,
        resetsAt: "2026-08-21T12:00:00.000Z",
        status: "ok",
      },
      rolling: {
        percent: 12,
        resetsAt: "2026-07-21T17:00:00.000Z",
        status: "ok",
      },
      weekly: {
        percent: 34,
        resetsAt: "2026-07-28T00:00:00.000Z",
        status: "ok",
      },
    },
  };

  it("maps rolling, weekly, and monthly used percents", () => {
    const result = mapOpenCodeGoUsagePayload(payload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "opencode-go",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 88,
            resetsAt: "2026-07-21T17:00:00.000Z",
          },
          {
            id: "7d",
            label: "7d",
            remainingPercent: 66,
            resetsAt: "2026-07-28T00:00:00.000Z",
          },
          {
            id: "month",
            label: "month",
            remainingPercent: 44,
            resetsAt: "2026-08-21T12:00:00.000Z",
          },
        ],
      },
    });
  });

  it("omits windows the payload does not include", () => {
    const result = mapOpenCodeGoUsagePayload(
      { usage: { rolling: { percent: 25, resetsAt: "2026-07-21T17:00:00.000Z" } } },
      NOW,
    );

    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "opencode-go",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 75,
            resetsAt: "2026-07-21T17:00:00.000Z",
          },
        ],
      },
    });
  });

  it("fails when a valid payload has no windows", () => {
    expect(mapOpenCodeGoUsagePayload({ usage: {} }, NOW)).toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "no usage windows in response" },
    });
  });

  it.each([-1, 101])("rejects out-of-range percent %s at ingress", async (percent) => {
    await expect(
      fetchOpenCodeGoUsage({
        authClient: tokenAuthClient("token"),
        fetchJson: okFetch({ usage: { rolling: { percent } } }),
        now: () => NOW,
      }),
    ).resolves.toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "invalid usage payload" },
    });
  });

  it("requests Go usage with a bearer API key", async () => {
    const client = { fetchJson: okFetch(payload) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    const result = await fetchOpenCodeGoUsage({
      authClient: {
        getProviderAuth: async () => ({
          auth: { apiKey: "opencode-key" },
          source: "OPENCODE_API_KEY",
        }),
      },
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    const [url, , options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(options?.headers?.Authorization).toBe("Bearer opencode-key");
    expect(result.ok).toBeTruthy();
  });

  it("treats a 403 as missing Go rather than broken auth", async () => {
    await expect(
      fetchOpenCodeGoUsage({
        authClient: tokenAuthClient("token"),
        fetchJson: async () => ({
          kind: "response",
          message: "OpenCode Go subscription required.",
          ok: false,
          status: 403,
        }),
        now: () => NOW,
      }),
    ).resolves.toStrictEqual({
      ok: false,
      error: {
        kind: "unavailable",
        message: "OpenCode Go subscription required.",
      },
    });
  });

  it("treats a 401 as a failed request", async () => {
    await expect(
      fetchOpenCodeGoUsage({
        authClient: tokenAuthClient("token"),
        fetchJson: async () => ({
          kind: "response",
          message: "Unauthorized",
          ok: false,
          status: 401,
        }),
        now: () => NOW,
      }),
    ).resolves.toStrictEqual({
      ok: false,
      error: { kind: "failure", message: "Unauthorized" },
    });
  });
});
