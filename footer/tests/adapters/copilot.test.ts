import { describe, expect, it, vi } from "vitest";

import {
  fetchCopilotUsage,
  parseCopilotUsagePayload,
} from "../../adapters/copilot.js";
import type { FetchJson } from "../../http.js";
import { NOW, tokenAuthClient } from "./helpers.js";

describe("copilot usage", () => {
  const payload = {
    quota_reset_date_utc: "2026-08-01T00:00:00.000Z",
    quota_snapshots: {
      chat: { percent_remaining: 80, unlimited: true },
      premium_interactions: { percent_remaining: 65 },
    },
  };

  it("maps quotas and skips unlimited quotas", () => {
    const result = parseCopilotUsagePayload(payload, NOW);
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "github-copilot",
        windows: [
          {
            id: "month",
            label: "Premium",
            remainingPercent: 65,
            resetsAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    });
  });

  it("fails when no quota snapshots are present", () => {
    expect(
      parseCopilotUsagePayload({ quota_snapshots: {} }, NOW).ok
    ).toBeFalsy();
  });

  it("requests the Copilot endpoint with its required headers", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => ({
      json: payload,
      ok: true,
    }));

    await fetchCopilotUsage({
      authClient: tokenAuthClient("copilot-token"),
      fetchJson,
      now: () => NOW,
    });

    const [url, options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/copilot_internal/user");
    expect(options?.headers?.Authorization).toBe("token copilot-token");
    expect(options?.headers?.["Editor-Version"]).toBe("vscode/1.96.2");
  });
});
