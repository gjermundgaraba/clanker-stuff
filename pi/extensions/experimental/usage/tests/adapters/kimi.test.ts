import { okFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchKimiUsage, mapKimiUsagePayload } from "../../adapters/kimi.js";
import type { FetchJson } from "../../http.js";
import { NOW, tokenAuth } from "./helpers.js";

describe("kimi usage", () => {
  const payload = {
    limits: [
      {
        detail: {
          limit: 100,
          remaining: 40,
          resetTime: "2026-07-21T14:00:00.000Z",
        },
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      },
    ],
    usage: {
      limit: 500,
      remaining: 250,
      resetTime: "2026-07-28T00:00:00.000Z",
    },
  };

  it("maps rolling limits and the weekly aggregate", () => {
    const result = mapKimiUsagePayload(payload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "kimi-coding",
        quotaWindows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 40,
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

  it.each([
    [{ duration: 60, timeUnit: "TIME_UNIT_MINUTE" }, "5h", "1h"],
    [{ duration: 24, timeUnit: "TIME_UNIT_HOUR" }, "week", "1d"],
    [{ duration: 1, timeUnit: "TIME_UNIT_DAY" }, "week", "1d"],
    [{ duration: 90, timeUnit: "TIME_UNIT_MINUTE" }, "5h", "90m"],
    [{ duration: 3, timeUnit: "TIME_UNIT_FORTNIGHT" }, "5h", "5h"],
  ])("labels a %o window with its actual length", (window, id, label) => {
    const result = mapKimiUsagePayload(
      { limits: [{ detail: { limit: 10, remaining: 5 }, window }] },
      NOW,
    );

    expect(result.ok && result.snapshot.quotaWindows).toStrictEqual([
      { id, label, remainingPercent: 50 },
    ]);
  });

  it("fails when nothing has a positive limit", () => {
    expect(mapKimiUsagePayload({ limits: [], usage: { limit: 0 } }, NOW).ok).toBeFalsy();
  });

  it("requests the coding usage endpoint with bearer auth", async () => {
    const client = { fetchJson: okFetch(payload) } satisfies { fetchJson: FetchJson };
    const fetchJson = vi.spyOn(client, "fetchJson");

    await fetchKimiUsage({
      getAuth: tokenAuth("kimi-token"),
      fetchJson: client.fetchJson,
      now: () => NOW,
    });

    const [url, , options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(options?.headers?.Authorization).toBe("Bearer kimi-token");
  });
});
