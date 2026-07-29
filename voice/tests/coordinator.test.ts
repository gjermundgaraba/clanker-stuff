import { describe, expect, it, vi } from "vitest";

import { VoiceCoordinator } from "../coordinator.js";

const binding = (delegationId: string) => ({
  callId: "call-1",
  delegationId,
});

describe("voice coordinator", () => {
  it("serializes submission and activates only the matching user message", async () => {
    const completions: { delegationId: string; text: string }[] = [];
    const statuses: { delegationId: string; text: string }[] = [];
    const submissions: string[] = [];
    const coordinator = new VoiceCoordinator({
      complete: (target, text) => {
        completions.push({ delegationId: target.delegationId, text });
        return true;
      },
      status: (target, text) => {
        statuses.push({ delegationId: target.delegationId, text });
        return true;
      },
      submit: (prompt) => {
        submissions.push(prompt);
      },
      validate: async () => {
        await Promise.resolve();
      },
    });

    coordinator.enqueue({ binding: binding("a"), prompt: "prompt-a" });
    coordinator.enqueue({ binding: binding("b"), prompt: "prompt-b" });
    await vi.waitFor(() => {
      expect(submissions).toStrictEqual(["prompt-a"]);
    });

    const firstResults = [
      coordinator.sendStatus("too early"),
      coordinator.accept("unrelated"),
      coordinator.accept("prompt-a"),
      coordinator.sendStatus("found a"),
      coordinator.finish("answer a"),
    ];

    await vi.waitFor(() => {
      expect(submissions).toStrictEqual(["prompt-a", "prompt-b"]);
    });
    const secondResults = [
      coordinator.accept("prompt-b"),
      coordinator.finish("answer b"),
    ];
    expect({
      completions,
      firstResults,
      secondResults,
      statuses,
    }).toStrictEqual({
      completions: [
        { delegationId: "a", text: "answer a" },
        { delegationId: "b", text: "answer b" },
      ],
      firstResults: [false, false, true, true, true],
      secondResults: [true, true],
      statuses: [{ delegationId: "a", text: "found a" }],
    });
  });

  it("fails a submitted handoff that Pi never accepts", async () => {
    const completions: string[] = [];
    const submit = vi.fn<(prompt: string) => void>();
    const coordinator = new VoiceCoordinator({
      complete: (_target, text) => {
        completions.push(text);
        return true;
      },
      status: () => true,
      submit,
      validate: async () => {
        await Promise.resolve();
      },
    });

    coordinator.enqueue({ binding: binding("a"), prompt: "prompt-a" });
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledOnce();
    });
    coordinator.settled();

    expect(completions).toStrictEqual([
      "I could not submit that request to the Pi session.",
    ]);
  });

  it("reports coordinator preflight failure without submitting", async () => {
    const completions: string[] = [];
    const submit = vi.fn<(prompt: string) => void>();
    const coordinator = new VoiceCoordinator({
      complete: (_target, text) => {
        completions.push(text);
        return true;
      },
      status: () => true,
      submit,
      validate: async () => {
        await Promise.resolve();
        throw new Error("missing auth");
      },
    });

    coordinator.enqueue({ binding: binding("a"), prompt: "prompt-a" });
    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    });

    expect(submit).not.toHaveBeenCalled();
    expect(completions[0]).toContain("missing auth");
  });
});
