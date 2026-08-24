import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { V1SnapshotSchema } from "../../v1/protocol.js";

const valid = <T>(candidate: T): boolean =>
  Value.Check(V1SnapshotSchema, {
    agents: [candidate],
    notifications: [],
  });

describe("V1 durable protocol", () => {
  const agent = {
    id: "agent",
    nickname: "Worker",
    sessionFile: "/sessions/worker.jsonl",
    tools: [],
  };
  const turn = {
    id: "turn",
    input: { text: "work" },
  };

  it("validates lifecycle fields by status while retaining prior answers", () => {
    for (const candidate of [
      {
        ...agent,
        active: { ...turn, phase: "pending" },
        edge: "open",
        lastAnswer: "prior answer",
        queue: [],
        status: "pending",
      },
      {
        ...agent,
        active: { ...turn, phase: "running" },
        edge: "open",
        lastAnswer: "prior answer",
        queue: [],
        status: "running",
      },
      {
        ...agent,
        edge: "open",
        lastAnswer: "prior answer",
        queue: [],
        status: "interrupted",
      },
      {
        ...agent,
        edge: "open",
        lastAnswer: "final answer",
        queue: [],
        status: "completed",
      },
      {
        ...agent,
        edge: "open",
        error: "failed",
        lastAnswer: "prior answer",
        queue: [],
        status: "errored",
      },
      {
        ...agent,
        edge: "closed",
        lastAnswer: "final answer",
        queue: [],
        status: "shutdown",
      },
    ]) {
      expect(valid(candidate)).toBeTruthy();
    }
  });

  it("rejects lifecycle fields that conflict with status", () => {
    for (const candidate of [
      { ...agent, edge: "open", queue: [], status: "pending" },
      {
        ...agent,
        active: { ...turn, phase: "pending" },
        edge: "open",
        queue: [],
        status: "running",
      },
      {
        ...agent,
        active: { ...turn, phase: "running" },
        edge: "open",
        queue: [],
        status: "interrupted",
      },
      {
        ...agent,
        edge: "open",
        error: "failed",
        queue: [],
        status: "completed",
      },
      { ...agent, edge: "open", queue: [], status: "errored" },
      {
        ...agent,
        edge: "closed",
        queue: [turn],
        status: "shutdown",
      },
      {
        ...agent,
        edge: "closed",
        queue: [],
        status: "completed",
      },
    ]) {
      expect(valid(candidate)).toBeFalsy();
    }
  });

  it("keeps queued turns phase-free", () => {
    expect(
      valid({
        ...agent,
        edge: "open",
        queue: [turn],
        status: "completed",
      }),
    ).toBeTruthy();
    expect(
      valid({
        ...agent,
        edge: "open",
        queue: [{ ...turn, phase: "pending" }],
        status: "completed",
      }),
    ).toBeFalsy();
  });
});
