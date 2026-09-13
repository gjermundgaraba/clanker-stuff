import { describe, expect, it } from "vite-plus/test";

import { scenarios } from "../scripts/evaluate-model-guidance.js";
import type { EvaluationTrace } from "../scripts/evaluate-model-guidance.js";

const calls = {
  spawn1: { args: { task_name: "v1_review" }, name: "spawn_agent" },
  spawn2: { args: { task_name: "v2_review" }, name: "spawn_agent" },
  send1: {
    args: { target: "/root/v1_review", message: "Coordinate with v2_review" },
    name: "send_message",
  },
  send2: {
    args: { target: "v2_review", message: "Coordinate with v1_review" },
    name: "send_message",
  },
  wait: { args: {}, name: "wait_agent" },
};

const trace = (order: readonly (keyof typeof calls)[]): EvaluationTrace => ({
  finalText: "Summary ADDRESSING_DONE",
  tools: order.map((key, sequence) => ({
    ...calls[key],
    error: false,
    sequence,
    toolCallId: String(sequence),
  })),
});

const valid = () => trace(["spawn1", "spawn2", "send1", "send2", "wait"]);
const validate = (value: EvaluationTrace): string[] => {
  const scenario = scenarios.find(({ id }) => id === "addressing-and-waiting");
  if (scenario === undefined) throw new Error("Missing addressing scenario");
  return scenario.validate(value);
};

describe("model guidance addressing validator", () => {
  it("accepts both spawns and both successful messages before waiting", () => {
    expect(validate(valid())).toEqual([]);
    expect(validate(trace(["spawn2", "spawn1", "send2", "send1", "wait"]))).toEqual([]);
  });

  it("rejects waiting between the two required messages", () => {
    expect(validate(trace(["spawn1", "spawn2", "send1", "wait", "send2"]))).toContain(
      "wait_agent ran before queue-only addressing completed",
    );
  });

  it("rejects waiting before either message", () => {
    expect(validate(trace(["wait", "spawn1", "spawn2", "send1", "send2"]))).toContain(
      "wait_agent ran before queue-only addressing completed",
    );
  });

  it("requires both spawns before any queue-only message", () => {
    expect(validate(trace(["spawn1", "send1", "spawn2", "send2", "wait"]))).toContain(
      "queue-only messages were sent before both spawns",
    );
  });

  it("requires exactly one message for each distinct target", () => {
    expect(validate(trace(["spawn1", "spawn2", "send1", "send1", "wait"]))).toContain(
      "expected one successful queue-only message per agent",
    );
    expect(validate(trace(["spawn1", "spawn2", "send1", "send2", "send1", "wait"]))).toContain(
      "expected one successful queue-only message per agent",
    );
  });

  it("rejects failed messages and missing cross-references", () => {
    const value = valid();
    expect(
      validate({
        ...value,
        tools: value.tools.map((call) =>
          call.name === "send_message" ? { ...call, error: true } : call,
        ),
      }),
    ).toContain("queue-only addressing included a failed message");
    expect(
      validate({
        ...value,
        tools: value.tools.map((call) =>
          call.name === "send_message"
            ? { ...call, args: { ...call.args, message: "hello" } }
            : call,
        ),
      }),
    ).toContain("message to v1_review did not name v2_review");
  });

  it("requires bounded waiting and the final completion marker", () => {
    expect(validate(trace(["spawn1", "spawn2", "send1", "send2"]))).toContain(
      "expected at least one wait_agent call",
    );
    expect(
      validate(
        trace(["spawn1", "spawn2", "send1", "send2", "wait", "wait", "wait", "wait", "wait"]),
      ),
    ).toContain("wait_agent usage suggests busy polling");
    expect(validate({ ...valid(), finalText: "unfinished" })).toContain(
      "final response must end with ADDRESSING_DONE",
    );
  });
});
