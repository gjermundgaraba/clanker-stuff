import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { catalogModels } from "../../models.js";
import { MessageUsage } from "../../query/usage.js";
import type { SdkUsage } from "../../query/usage.js";
import { recordedStream } from "../fixtures/sdk.js";
import { testModel } from "../helpers.js";
import { assistant } from "../session/messages.js";

const model = testModel();

const pricedModel: Model<Api> = {
  ...testModel(),
  cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
};

const usageOfOneRequest = (
  frames: readonly SdkUsage[],
  priced: Model<Api> = model
): Usage => {
  const { usage } = assistant([]);
  const ledger = new MessageUsage(priced);

  for (const frame of frames) {
    ledger.record(usage, frame, "msg_1");
  }

  return usage;
};

describe("one request's usage", () => {
  it("maps the four flat counters and totals them", () => {
    expect(
      usageOfOneRequest([
        {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      ])
    ).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
    });
  });

  it("reads the nested thinking count onto usage.reasoning", () => {
    expect(
      usageOfOneRequest([
        { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      ]).reasoning
    ).toBe(40);
  });

  it("ignores a flat thinking_tokens or a reasoning_tokens field", () => {
    const flat = { output_tokens: 100, thinking_tokens: 40 };
    const renamed = { output_tokens: 100, reasoning_tokens: 40 };

    expect(usageOfOneRequest([flat]).reasoning).toBeUndefined();
    expect(usageOfOneRequest([renamed]).reasoning).toBeUndefined();
  });

  it("keeps reasoning out of the token total", () => {
    expect(
      usageOfOneRequest([
        { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      ]).totalTokens
    ).toBe(100);
  });

  it("bills the counters and never the reasoning tokens", () => {
    expect(
      usageOfOneRequest(
        [
          {
            input_tokens: 10,
            output_tokens: 100,
            output_tokens_details: { thinking_tokens: 40 },
          },
        ],
        pricedModel
      ).cost.total
    ).toBe(210);
  });

  it("bills 1h cache writes at twice the input rate and keeps the split across a frame without it", () => {
    const cached: Model<Api> = {
      ...testModel(),
      cost: {
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1_250_000,
      },
    };

    const messageDeltaWithoutSplit = {
      cache_creation_input_tokens: 10,
      output_tokens: 1,
    };

    const usage = usageOfOneRequest(
      [
        {
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_1h_input_tokens: 8 },
        },
        messageDeltaWithoutSplit,
      ],
      cached
    );

    expect(usage.cacheWrite1h).toBe(8);
    expect(usage.cost.cacheWrite).toBe(2 * 1.25 + 8 * 2);
  });

  it("only overwrites counters the frame carries", () => {
    expect(
      usageOfOneRequest([
        { input_tokens: 5, cache_read_input_tokens: 3 },
        { output_tokens: 7, input_tokens: null },
      ])
    ).toMatchObject({ input: 5, cacheRead: 3, output: 7, totalTokens: 15 });
  });
});

describe("a message spanning several requests", () => {
  it("reports the last request, with nothing an earlier one carried", () => {
    const { usage } = assistant([]);
    const ledger = new MessageUsage(pricedModel);

    ledger.record(
      usage,
      {
        input_tokens: 10,
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 1000 },
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 3 },
      },
      "msg_stalled"
    );
    ledger.record(usage, { input_tokens: 12, output_tokens: 40 }, "msg_retry");

    expect(usage).toStrictEqual({
      input: 12,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 52,
      cost: {
        input: 12,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        total: 92,
        totalFromProvider: false,
      },
    });
  });

  it("applies a frame without an id to the request the last frame came from", () => {
    const { usage } = assistant([]);
    const ledger = new MessageUsage(model);

    ledger.record(usage, { input_tokens: 10 }, "msg_a");
    ledger.record(usage, { output_tokens: 30 });

    expect(usage).toMatchObject({ input: 10, output: 30, totalTokens: 40 });
  });
});

describe("pricing", () => {
  it("matches Claude Code's own cost for a recorded two-request query, request by request", () => {
    const haiku = catalogModels().find(({ id }) => id === "claude-haiku-4-5");
    const messages: SDKMessage[] = recordedStream("parallel-tools");
    const requests: Usage[] = [];
    let ledger = new MessageUsage(haiku ?? model);

    for (const message of messages) {
      if (message.type !== "stream_event") {
        continue;
      }

      const { event } = message;

      if (event.type === "message_start") {
        const { usage } = assistant([]);

        requests.push(usage);
        ledger = new MessageUsage(haiku ?? model);
        ledger.record(usage, event.message.usage, event.message.id);
      } else if (event.type === "message_delta" && requests.length > 0) {
        ledger.record(requests.at(-1) ?? assistant([]).usage, event.usage);
      }
    }

    const result = messages.find((message) => message.type === "result");
    const billed = requests.reduce((sum, usage) => sum + usage.cost.total, 0);

    expect(haiku).toBeDefined();
    expect(requests).toHaveLength(2);
    expect(billed).toBeCloseTo(result?.total_cost_usd ?? -1, 9);
  });
});
