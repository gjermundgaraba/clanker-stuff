import { describe, expect, it } from "vite-plus/test";

import { mapClaudeBridgeHeaders } from "../../adapters/claude-bridge.js";
import { NOW } from "./helpers.js";

const headers = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-5h-utilization": "0.25",
  "anthropic-ratelimit-unified-5h-reset": "1793120400",
  "anthropic-ratelimit-unified-7d-utilization": "0.5",
  "anthropic-ratelimit-unified-7d-reset": "1793642400",
};

describe("claude-bridge usage", () => {
  it("maps the 5-hour and weekly windows from fractions and Unix-second resets", () => {
    expect(mapClaudeBridgeHeaders(headers, NOW)).toStrictEqual({
      ok: true,
      snapshot: {
        fetchedAt: NOW,
        provider: "claude-bridge",
        quotaWindows: [
          {
            label: "5h",
            remainingPercent: 75,
            resetsAt: new Date(1_793_120_400_000).toISOString(),
          },
          {
            label: "week",
            remainingPercent: 50,
            resetsAt: new Date(1_793_642_400_000).toISOString(),
          },
        ],
      },
    });
  });

  it("keeps a window whose reset is missing or unreadable", () => {
    const result = mapClaudeBridgeHeaders(
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "soon",
      },
      NOW
    );

    expect(result.ok && result.snapshot.quotaWindows).toStrictEqual([
      { label: "5h", remainingPercent: 75 },
    ]);
  });

  it("fails a response that reports no window, such as another provider's", () => {
    expect(
      mapClaudeBridgeHeaders(
        {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "",
          "content-type": "text/event-stream",
        },
        NOW
      ).ok
    ).toBe(false);
  });
});
