import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { updateUsage } from "../../query/usage.js";
import { newAssistantOutput } from "../../translate.js";
import { testModel } from "../helpers.js";

const model = testModel();

const pricedModel: Model<Api> = {
  ...testModel(),
  cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
};

const emptyOutput = () => newAssistantOutput(model, "stop");

describe("updateUsage", () => {
  it("maps the four flat counters and totals them", () => {
    const output = emptyOutput();

    updateUsage(
      output,
      {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      model
    );

    expect(output.usage).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
    });
  });

  it("reads the nested thinking count onto usage.reasoning", () => {
    const output = emptyOutput();

    updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model
    );

    expect(output.usage.reasoning).toBe(40);
  });

  it("ignores a flat thinking_tokens or a reasoning_tokens field", () => {
    const flat = { output_tokens: 100, thinking_tokens: 40 };
    const renamed = { output_tokens: 100, reasoning_tokens: 40 };
    const first = emptyOutput();
    const second = emptyOutput();

    updateUsage(first, flat, model);
    updateUsage(second, renamed, model);

    expect(first.usage.reasoning).toBeUndefined();
    expect(second.usage.reasoning).toBeUndefined();
  });

  it("keeps reasoning out of the token total", () => {
    const output = emptyOutput();

    updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model
    );

    expect(output.usage.totalTokens).toBe(100);
  });

  it("bills the counters and never the reasoning tokens", () => {
    const output = emptyOutput();

    updateUsage(
      output,
      {
        input_tokens: 10,
        output_tokens: 100,
        output_tokens_details: { thinking_tokens: 40 },
      },
      pricedModel
    );

    expect(output.usage.cost.total).toBe(210);
  });

  it("reports the cache share of the prompt, zero without a prompt", () => {
    expect(
      updateUsage(
        emptyOutput(),
        { input_tokens: 25, cache_read_input_tokens: 75 },
        model
      ).cachePct
    ).toBe(75);
    expect(
      updateUsage(emptyOutput(), { output_tokens: 10 }, model).cachePct
    ).toBe(0);
  });

  it("only overwrites counters the frame carries", () => {
    const output = emptyOutput();

    updateUsage(output, { input_tokens: 5, cache_read_input_tokens: 3 }, model);
    updateUsage(output, { output_tokens: 7, input_tokens: null }, model);

    expect(output.usage).toMatchObject({
      input: 5,
      cacheRead: 3,
      output: 7,
      totalTokens: 15,
    });
  });

  it("reports only the thinking count this frame carries", () => {
    const output = emptyOutput();

    const first = updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model
    );

    const second = updateUsage(output, { output_tokens: 120 }, model);

    expect(first.reasoning).toBe(40);
    expect(second).not.toHaveProperty("reasoning");
    expect(output.usage.reasoning).toBe(40);
  });
});
