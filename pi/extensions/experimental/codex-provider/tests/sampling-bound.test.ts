import { getEncoding, Tiktoken } from "js-tiktoken";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CodexSamplingBound } from "../sampling-bound.js";
import { SPIKE_MODEL, wireRecord, wireString } from "./fixtures.js";

const model = { ...SPIKE_MODEL, id: "gpt-5.6-sol", maxTokens: 128_000 };

const tokenizer = getEncoding("o200k_base");

const added = (index = 0) => ({
  type: "response.output_item.added",
  output_index: index,
  item: { type: "message" },
});

const delta = (text: string, index = 0) => ({
  type: "response.output_text.delta",
  output_index: index,
  delta: text,
});

const done = (text: string, index = 0) => ({
  type: "response.output_item.done",
  output_index: index,
  item: { type: "message", content: [{ type: "output_text", text }] },
});

const completedText = (event: ReturnType<CodexSamplingBound["transform"]>) => {
  const content = wireRecord(wireRecord(event).item).content;

  if (!Array.isArray(content)) throw new Error("Expected completed message");

  return wireString(wireRecord(content[0]).text);
};

afterEach(() => vi.restoreAllMocks());

describe("sampling tokenization work", () => {
  it("bounds aggregate encoded input for growing streams instead of reencoding every delta", () => {
    const encode = vi.spyOn(Tiktoken.prototype, "encode");

    const work = (count: number) => {
      const bound = new CodexSamplingBound(model, model.maxTokens);
      bound.transform(added());
      encode.mockClear();

      for (let i = 0; i < count; i++) bound.transform(delta(" word"));
      const text = " word".repeat(count);
      expect(completedText(bound.transform(done(text)))).toBe(text);
      const encodedLength = encode.mock.calls.reduce((sum, [input]) => sum + input.length, 0);
      expect(encodedLength).toBeLessThan(text.length * 12);
      expect(encode.mock.calls.length).toBeLessThan(100);

      return encodedLength;
    };

    expect(work(8000)).toBeLessThan(work(4000) * 2.5);
  });

  it("emits only exactly bounded batches across Unicode and interleaved item boundaries", () => {
    for (const budget of [1, 2, 7, 64]) {
      const bound = new CodexSamplingBound(model, budget);
      const emitted = ["", ""];
      const source = ["interesting 世界 👩🏽‍💻", "é combining e\u0301 refusal"];

      for (let index = 0; index < 2; index++) bound.transform(added(index));

      // Split UTF-16 code units, including surrogate pairs, across deltas.
      for (let offset = 0; offset < 2000 && !bound.status.limitReached; offset++) {
        const index = offset % 2;
        const text = source[index]!;
        const event = bound.transform(delta(text[Math.floor(offset / 2) % text.length]!, index));

        if (event && "delta" in event) emitted[index] += wireString(event.delta);
        expect(tokenizer.encode(emitted.join(""), [], []).length).toBeLessThanOrEqual(budget);
      }

      expect(bound.status.limitReached).toBe(true);
    }
  });

  it("uses authoritative completion instead of a buffered tail and verifies changed BPE joins", () => {
    const bound = new CodexSamplingBound(model, 8);
    bound.transform(added());
    expect(bound.transform(delta("stale"))).toBeUndefined();
    expect(completedText(bound.transform(done("interesting")))).toBe("interesting");
    bound.transform(added(1));
    expect(bound.transform(delta("tail", 1))).toBeUndefined();

    const completion = {
      ...done("", 1),
      item: {
        type: "message",
        content: [{ type: "refusal", refusal: " 世界 👩🏽‍💻".repeat(30) }],
      },
    };

    const event = bound.transform(completion);

    const returned = "interesting" + completedText(event);
    expect(returned).not.toContain("stale");
    expect(returned).not.toContain("tail");
    expect(returned).not.toContain("\uFFFD");
    expect(tokenizer.encode(returned, [], []).length).toBeLessThanOrEqual(8);
    expect(bound.status.limitReached).toBe(true);
  });
});

describe("sampling event validation", () => {
  it.each([
    null,
    {},
    { type: "message", content: null },
    { type: "message", content: [{ type: "output_text", text: 42 }] },
    { type: "message", content: [{ type: "refusal", refusal: false }] },
    { type: "message", content: [{ type: "image", text: "not text" }] },
  ])("rejects malformed output items without completing the message: %j", (item) => {
    const bound = new CodexSamplingBound(model, 64);
    bound.transform(added());
    const malformed = { ...done(""), item };

    expect(() => bound.transform(malformed)).toThrow(/Malformed sampling/);
    expect(completedText(bound.transform(done("valid")))).toBe("valid");
  });

  it("rejects malformed deltas before changing buffered text", () => {
    const bound = new CodexSamplingBound(model, 64);
    bound.transform(added());
    const malformed = { ...delta(""), delta: 42 };

    expect(() => bound.transform(malformed)).toThrow("Malformed sampling text delta");
    expect(completedText(bound.transform(done("valid")))).toBe("valid");
  });

  it("retains wire metadata and the original event while bounding mixed content", () => {
    const bound = new CodexSamplingBound(model, 64);
    bound.transform(added());

    const completion = {
      ...done(""),
      sequence_number: 7,
      item: {
        id: "message-id",
        type: "message",
        phase: "final_answer",
        content: [
          { type: "output_text", text: "hello " },
          { type: "refusal", refusal: "world" },
        ],
      },
    };

    const before = structuredClone(completion);
    const result = bound.transform(completion);

    expect(result).toEqual({
      ...completion,
      item: {
        ...completion.item,
        content: [{ type: "output_text", text: "hello world", annotations: [] }],
      },
    });
    expect(completion).toEqual(before);
  });

  it("passes through unrelated events and filters reasoning", () => {
    const bound = new CodexSamplingBound(model, 64);
    const terminal = { type: "response.completed", response: { id: "response-id" } };
    const reasoning = { type: "response.output_item.added", item: { type: "reasoning" } };

    expect(bound.transform(terminal)).toBe(terminal);
    expect(bound.transform(reasoning)).toBeUndefined();
    expect(bound.transform({ type: "response.reasoning_text.delta" })).toBeUndefined();
  });
});
