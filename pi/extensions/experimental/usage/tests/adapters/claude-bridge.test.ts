import { describe, expect, it } from "vite-plus/test";

import { planUsageResponse } from "../../../claude-bridge/query/rate-limit.js";
import {
  CLAUDE_BRIDGE_PLAN_USAGE_HEADER,
  mapClaudeBridgePlanUsage,
} from "../../adapters/claude-bridge.js";
import { NOW } from "./helpers.js";

const reporting = (windows: unknown) => ({
  [CLAUDE_BRIDGE_PLAN_USAGE_HEADER]: JSON.stringify(windows),
});

describe("claude-bridge usage", () => {
  it("maps the 5-hour and weekly windows from fractions and Unix-second resets", () => {
    expect(
      mapClaudeBridgePlanUsage(
        reporting({
          five_hour: {
            status: "allowed",
            utilization: 0.25,
            resetsAt: 1_793_120_400,
          },
          seven_day: { utilization: 0.5, resetsAt: 1_793_642_400 },
          seven_day_overage_included: { utilization: 0.9 },
        }),
        NOW
      )
    ).toStrictEqual({
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

  it("keeps the windows it can read when another changed shape", () => {
    const result = mapClaudeBridgePlanUsage(
      reporting({
        five_hour: { utilization: 0.25 },
        seven_day: { utilization: "half" },
      }),
      NOW
    );

    expect(result?.ok === true && result.snapshot.quotaWindows).toStrictEqual([
      { label: "5h", remainingPercent: 75 },
    ]);
  });

  it("fails a report it cannot read", () => {
    expect(
      mapClaudeBridgePlanUsage(
        { [CLAUDE_BRIDGE_PLAN_USAGE_HEADER]: "{not json" },
        NOW
      )?.ok
    ).toBe(false);
  });

  it("is not claude-bridge's usage without its header, such as an Anthropic response", () => {
    expect(
      mapClaudeBridgePlanUsage(
        {
          "anthropic-ratelimit-unified-5h-utilization": "0.25",
          "content-type": "text/event-stream",
        },
        NOW
      )
    ).toBeUndefined();
  });

  it("reads what claude-bridge reports for a rate_limit_event", () => {
    const event: Parameters<typeof planUsageResponse>[0] & {
      unifiedWindows: unknown;
    } = {
      status: "allowed",
      unifiedWindows: {
        five_hour: { status: "allowed", utilization: 0.25, resetsAt: 1 },
      },
    };

    const response = planUsageResponse(event);

    const result = mapClaudeBridgePlanUsage(response?.headers ?? {}, NOW);

    expect(result?.ok === true && result.snapshot.quotaWindows).toStrictEqual([
      {
        label: "5h",
        remainingPercent: 75,
        resetsAt: new Date(1000).toISOString(),
      },
    ]);
  });
});
