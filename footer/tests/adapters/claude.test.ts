import { describe, expect, it, vi } from "vitest";

import {
  fetchClaudeUsage,
  parseClaudeUsagePayload,
} from "../../adapters/claude.js";
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
    const result = parseClaudeUsagePayload(payload, NOW);
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

  it("fails when no windows are present or utilization is out of range", () => {
    expect(parseClaudeUsagePayload({}, NOW).ok).toBeFalsy();
    expect(
      parseClaudeUsagePayload({ five_hour: { utilization: -1 } }, NOW).ok
    ).toBeFalsy();
    expect(
      parseClaudeUsagePayload({ five_hour: { utilization: 101 } }, NOW).ok
    ).toBeFalsy();
  });

  it("requests OAuth usage with Anthropic headers", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => ({
      json: payload,
      ok: true,
    }));

    await fetchClaudeUsage({
      authClient: tokenAuthClient("claude-token"),
      fetchJson,
      now: () => NOW,
    });

    const [url, options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(options?.headers?.Authorization).toBe("Bearer claude-token");
    expect(options?.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
});
