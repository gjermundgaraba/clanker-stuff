import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  PLAN_USAGE_HEADER,
  planUsageResponse,
} from "../../query/rate-limit.js";
import { recordedStream } from "../fixtures/sdk.js";

const recordedInfo = () => {
  const event = recordedStream("text").find(
    (message: SDKMessage) => message.type === "rate_limit_event"
  );

  if (event?.type !== "rate_limit_event") {
    throw new Error("the recorded stream has no rate_limit_event");
  }

  return event.rate_limit_info;
};

describe(planUsageResponse, () => {
  it("sends on every window Claude Code reported in its undeclared field", () => {
    const response = planUsageResponse(recordedInfo());

    expect(response?.status).toBe(200);
    expect(
      JSON.parse(response?.headers[PLAN_USAGE_HEADER] ?? "null")
    ).toStrictEqual({
      five_hour: {
        status: "allowed",
        utilization: 0.19,
        resetsAt: 1_793_120_400,
      },
      seven_day: {
        status: "allowed",
        utilization: 0.2,
        resetsAt: 1_793_642_400,
      },
    });
  });

  it("reports nothing for an event without the field", () => {
    expect(planUsageResponse({ status: "allowed" })).toBeUndefined();
  });
});
