import { describe, expect, it, vi } from "vite-plus/test";

import { fetchMinimaxUsage, parseMinimaxUsagePayload } from "../../adapters/minimax.js";
import type { FetchJson } from "../../http.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

const payload = {
  model_remains: [
    {
      current_interval_remaining_percent: 60,
      current_interval_status: 1,
      current_weekly_remaining_percent: 45,
      end_time: NOW + 2 * 3_600_000,
      model_name: "general",
      weekly_end_time: NOW + 3 * 86_400_000,
    },
  ],
};

describe("minimax usage", () => {
  it("maps interval and weekly remaining percents", () => {
    const result = parseMinimaxUsagePayload(payload, "minimax", NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "minimax",
        windows: [
          {
            id: "5h",
            label: "5h",
            remainingPercent: 60,
            resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
          },
          {
            id: "week",
            label: "week",
            remainingPercent: 45,
            resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
          },
        ],
      },
    });
  });

  it("surfaces API errors", () => {
    const result = parseMinimaxUsagePayload(
      { base_resp: { status_code: 1002, status_msg: "invalid token" } },
      "minimax",
      NOW,
    );
    expect(result).toStrictEqual({
      error: { kind: "failure", message: "invalid token" },
      ok: false,
    });
  });

  it("uses the China endpoint for minimax-cn", async () => {
    const fetchJson = vi.fn<FetchJson>(okFetch(payload));
    const result = await fetchMinimaxUsage(
      { authClient: tokenAuthClient("mm-token"), fetchJson, now: () => NOW },
      "minimax-cn",
    );
    expect(fetchJson.mock.calls[0]?.[0]).toContain("minimaxi.com");
    expect(result.ok && result.snapshot.provider).toBe("minimax-cn");
  });
});
