import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { rateLimitResponse } from "../../query/rate-limit.js";
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

describe("rateLimitResponse", () => {
  it("names every window Claude Code reported the way the Anthropic API does", () => {
    expect(rateLimitResponse(recordedInfo())).toStrictEqual({
      status: 200,
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-reset": "1793120400",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "0.19",
        "anthropic-ratelimit-unified-5h-reset": "1793120400",
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": "1793642400",
      },
    });
  });

  it("reports no windows when Claude Code's undeclared field is not the shape it reads", () => {
    const info = { ...recordedInfo(), unifiedWindows: { five_hour: "full" } };

    expect(Object.keys(rateLimitResponse(info).headers)).not.toContain(
      "anthropic-ratelimit-unified-5h-utilization"
    );
  });
});
