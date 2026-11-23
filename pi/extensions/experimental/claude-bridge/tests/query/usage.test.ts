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
    ledger.record(usage, "msg_1", frame);
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

  it("reports the cache share of the prompt, zero without a prompt", () => {
    const { usage } = assistant([]);

    expect(
      new MessageUsage(model).record(usage, "msg_1", {
        input_tokens: 25,
        cache_read_input_tokens: 75,
      }).cachePct
    ).toBe(75);
    expect(
      new MessageUsage(model).record(usage, "msg_2", { output_tokens: 10 })
        .cachePct
    ).toBe(0);
  });

  it("reports only the thinking count this frame carries", () => {
    const { usage } = assistant([]);
    const ledger = new MessageUsage(model);

    const first = ledger.record(usage, "msg_1", {
      output_tokens: 100,
      output_tokens_details: { thinking_tokens: 40 },
    });

    const second = ledger.record(usage, "msg_1", { output_tokens: 120 });

    expect(first.reasoning).toBe(40);
    expect(second).not.toHaveProperty("reasoning");
    expect(usage.reasoning).toBe(40);
  });
});

describe("a message spanning several requests", () => {
  it("sums what each request billed and keeps the latest request as the total", () => {
    const { usage } = assistant([]);
    const ledger = new MessageUsage(pricedModel);

    ledger.record(usage, "msg_stalled", {
      input_tokens: 10,
      cache_read_input_tokens: 1000,
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 3 },
    });
    ledger.record(usage, "msg_retry", {
      input_tokens: 12,
      cache_read_input_tokens: 1000,
      output_tokens: 40,
      output_tokens_details: { thinking_tokens: 20 },
    });

    expect(usage).toMatchObject({
      input: 22,
      output: 45,
      cacheRead: 2000,
      reasoning: 23,
      totalTokens: 12 + 1000 + 40,
    });
    expect(usage.cost.total).toBe(22 + 45 * 2);
  });

  it("does not count a request again when its frames repeat", () => {
    const { usage } = assistant([]);
    const ledger = new MessageUsage(model);
    const start = { input_tokens: 10, output_tokens: 1 };

    ledger.record(usage, "msg_a", start);
    ledger.record(usage, "msg_b", { input_tokens: 20, output_tokens: 2 });
    ledger.record(usage, "msg_a", { ...start, output_tokens: 30 });

    expect(usage).toMatchObject({ input: 30, output: 32, totalTokens: 22 });
  });

  it("prices each request at its own tier, not the summed prompt's", () => {
    const tiered: Model<Api> = {
      ...testModel(),
      cost: {
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tiers: [
          {
            inputTokensAbove: 150,
            input: 2_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
      },
    };

    const { usage } = assistant([]);
    const ledger = new MessageUsage(tiered);

    ledger.record(usage, "msg_a", { input_tokens: 100 });
    ledger.record(usage, "msg_b", { input_tokens: 100 });

    expect(usage.cost.total).toBe(200);
  });

  it("matches Claude Code's own cost for a recorded two-request query", () => {
    const haiku = catalogModels().find(({ id }) => id === "claude-haiku-4-5");
    const messages: SDKMessage[] = recordedStream("parallel-tools");
    const { usage } = assistant([]);
    const ledger = new MessageUsage(haiku ?? model);
    let streaming = "";

    for (const message of messages) {
      if (message.type !== "stream_event") {
        continue;
      }

      const { event } = message;

      if (event.type === "message_start") {
        streaming = event.message.id;
        ledger.record(usage, streaming, event.message.usage);
      } else if (event.type === "message_delta") {
        ledger.record(usage, streaming, event.usage);
      }
    }

    const result = messages.find((message) => message.type === "result");

    expect(haiku).toBeDefined();
    expect(usage.cost.total).toBeCloseTo(result?.total_cost_usd ?? -1, 9);
  });
});
