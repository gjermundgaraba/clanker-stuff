import { describe, expect, it, vi } from "vitest";

import {
  fetchGeminiUsage,
  parseGeminiUsagePayload,
} from "../../adapters/gemini.js";
import type { FetchJson } from "../../http.js";
import { NOW, okFetch, tokenAuthClient } from "./helpers.js";

describe("gemini usage", () => {
  it("keeps the tightest bucket per model family", () => {
    const result = parseGeminiUsagePayload(
      {
        buckets: [
          { modelId: "gemini-2.5-pro", remainingFraction: 0.4 },
          { modelId: "gemini-2.5-pro-exp", remainingFraction: 0.7 },
          { modelId: "gemini-2.5-flash", remainingFraction: 0.9 },
        ],
      },
      NOW
    );
    expect(result).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "google-gemini-cli",
        windows: [
          { id: "day", label: "Pro", remainingPercent: 40 },
          { id: "day", label: "Flash", remainingPercent: 90 },
        ],
      },
    });
  });

  it("fails when no pro or flash buckets are present", () => {
    expect(
      parseGeminiUsagePayload(
        { buckets: [{ modelId: "other", remainingFraction: 0.5 }] },
        NOW
      ).ok
    ).toBeFalsy();
  });

  it("posts to the quota endpoint with the resolved token", async () => {
    const fetchJson = vi.fn<FetchJson>(okFetch({ buckets: [] }));
    await fetchGeminiUsage({
      authClient: tokenAuthClient("gemini-token"),
      fetchJson,
      now: () => NOW,
    });
    const [url, options] = fetchJson.mock.calls[0] ?? [];
    expect(url).toContain("retrieveUserQuota");
    expect(options?.method).toBe("POST");
    expect(options?.headers?.Authorization).toBe("Bearer gemini-token");
  });
});
