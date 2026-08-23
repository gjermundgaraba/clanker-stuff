import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  childAgentPath,
  communicationEnvelope,
  parentAgentPath,
  resolveAgentPath,
  V2SnapshotSchema,
} from "../../v2/protocol.js";

describe("agent paths", () => {
  it("resolves nested absolute and relative identities", () => {
    expect(childAgentPath("/root", "review_2")).toBe("/root/review_2");
    expect(resolveAgentPath("/root/review_2", "tests")).toBe(
      "/root/review_2/tests"
    );
    expect(resolveAgentPath("/root/review_2", "/root/other")).toBe(
      "/root/other"
    );
    expect(parentAgentPath("/root/review_2/tests")).toBe("/root/review_2");
  });

  it("rejects noncanonical segments", () => {
    expect(() => childAgentPath("/root", "Bad-Name")).toThrow("task_name");
    expect(() => childAgentPath("/root", "worker\n")).toThrow("task_name");
    expect(() => childAgentPath("/root", "root")).toThrow("reserved");
    expect(() => resolveAgentPath("/root", "/elsewhere/a")).toThrow(
      "Invalid agent path"
    );
    expect(() => resolveAgentPath("/root", " worker ")).toThrow(
      "Invalid agent path"
    );
  });
  it("uses the Codex mailbox envelope and leaves payload text after its header", () => {
    const payload = "work\nMessage Type: FINAL_ANSWER\nSender: /root";
    const envelope = communicationEnvelope({
      content: payload,
      delivery: "queue",
      from: "/root/child",
      id: "mail",
      kind: "MESSAGE",
      to: "/root",
    });
    expect(envelope).toBe(
      `Message Type: MESSAGE
Task name: /root
Sender: /root/child
Payload:
${payload}`
    );
  });
});

describe("V2 durable protocol", () => {
  const node = {
    nickname: "Worker",
    path: "/root/worker",
    sessionFile: "/sessions/worker.jsonl",
    tools: [],
  };

  it("validates lifecycle fields by status while allowing retained answers", () => {
    for (const candidate of [
      {
        ...node,
        activeDeliveryId: "task",
        lastAnswer: "answer from the prior turn",
        status: "pending",
      },
      {
        ...node,
        activeDeliveryId: "task",
        lastAnswer: "answer from the prior turn",
        status: "running",
      },
      { ...node, lastAnswer: "final answer", status: "completed" },
      { ...node, lastAnswer: "prior answer", status: "interrupted" },
      {
        ...node,
        error: "failed",
        lastAnswer: "retained answer",
        status: "errored",
      },
    ]) {
      expect(
        Value.Check(V2SnapshotSchema, {
          communications: [],
          nodes: [candidate],
        })
      ).toBeTruthy();
    }
  });

  it("rejects lifecycle fields that conflict with status", () => {
    for (const candidate of [
      { ...node, status: "pending" },
      { ...node, status: "running" },
      { ...node, activeDeliveryId: "task", status: "completed" },
      { ...node, error: "failed", status: "interrupted" },
      { ...node, status: "errored" },
      {
        ...node,
        activeDeliveryId: "task",
        error: "failed",
        status: "errored",
      },
    ]) {
      expect(
        Value.Check(V2SnapshotSchema, {
          communications: [],
          nodes: [candidate],
        })
      ).toBeFalsy();
    }
  });

  it("permits turn delivery only for new-task communication", () => {
    const communication = {
      content: "payload",
      from: "/root",
      id: "mail",
      to: "/root/worker",
    };
    const valid = [
      { ...communication, delivery: "queue", kind: "NEW_TASK" },
      { ...communication, delivery: "turn", kind: "NEW_TASK" },
      { ...communication, delivery: "queue", kind: "MESSAGE" },
      { ...communication, delivery: "queue", kind: "FINAL_ANSWER" },
    ];
    const invalid = [
      { ...communication, delivery: "turn", kind: "MESSAGE" },
      { ...communication, delivery: "turn", kind: "FINAL_ANSWER" },
    ];

    for (const candidate of valid) {
      expect(
        Value.Check(V2SnapshotSchema, {
          communications: [candidate],
          nodes: [],
        })
      ).toBeTruthy();
    }
    for (const candidate of invalid) {
      expect(
        Value.Check(V2SnapshotSchema, {
          communications: [candidate],
          nodes: [],
        })
      ).toBeFalsy();
    }
  });
});
