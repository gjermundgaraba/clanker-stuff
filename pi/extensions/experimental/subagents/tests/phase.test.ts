import { describe, expect, it, vi } from "vite-plus/test";

import { agentMachine, holdsSlot, project, restore } from "../phase.js";
import type { AgentEvent, AgentSnapshot, Turn } from "../phase.js";
import type { ChildRuntime } from "../runtime.js";

const send = (agent: AgentSnapshot, event: AgentEvent): AgentSnapshot =>
  agentMachine.transition(agent, event)[0];

const runtime: ChildRuntime = {
  abort: vi.fn<ChildRuntime["abort"]>(),
  deliver: vi.fn<ChildRuntime["deliver"]>(),
  dispose: vi.fn<ChildRuntime["dispose"]>(),
  model: "provider/child",
  sessionFile: "/child.jsonl",
  snapshot: vi.fn<ChildRuntime["snapshot"]>(),
  startTurn: vi.fn<ChildRuntime["startTurn"]>(),
  steer: vi.fn<ChildRuntime["steer"]>(),
  thinkingLevel: "off",
  toolRenderers: vi.fn<ChildRuntime["toolRenderers"]>(),
};

const turn = (): Turn => ({
  retired: Promise.withResolvers<undefined>(),
  runtime,
});

const running = (current: Turn): AgentSnapshot =>
  send(send(agentMachine.initialState, { type: "spawn.reserve" }), {
    type: "spawn.started",
    turn: current,
  });

describe("agentMachine", () => {
  it("a settled turn retires only with the running turn's token", () => {
    const current = turn();
    const stale = turn();
    const live = running(current);

    expect(live.value).toBe("running");
    expect(project(live)).toStrictEqual({ status: "running" });
    expect(
      send(live, {
        at: 5,
        outcome: { status: "completed", text: "stale" },
        turn: stale,
        type: "turn.settled",
      })
    ).toBe(live);

    const retiring = send(live, {
      at: 10,
      outcome: { status: "completed", text: "done" },
      turn: current,
      type: "turn.settled",
    });

    expect(retiring.value).toBe("retiring");
    expect(project(retiring)).toStrictEqual({
      endedAt: 10,
      lastAnswer: "done",
      status: "completed",
    });
    expect(
      send(retiring, {
        at: 20,
        outcome: { error: "late", status: "errored" },
        turn: current,
        type: "turn.settled",
      })
    ).toBe(retiring);
    expect(send(retiring, { type: "followup.reserve" })).toBe(retiring);
    expect(send(retiring, { turn: stale, type: "retire.done" })).toBe(retiring);
    expect(holdsSlot(retiring)).toBe(true);

    const idle = send(retiring, { turn: current, type: "retire.done" });

    expect(idle.value).toBe("idle");
    expect(project(idle)).toStrictEqual(project(retiring));
    expect(holdsSlot(idle)).toBe(false);
  });

  it("an interrupted outcome records interrupted rather than leaving running", () => {
    const current = turn();

    const cancelled = send(running(current), {
      at: 7,
      outcome: { status: "interrupted" },
      turn: current,
      type: "turn.settled",
    });

    expect(cancelled.value).toBe("retiring");
    expect(project(cancelled)).toStrictEqual({
      endedAt: 7,
      status: "interrupted",
    });

    const interrupted = send(running(current), { at: 9, type: "interrupt" });

    expect(interrupted.value).toBe("retiring");
    expect(project(interrupted)).toStrictEqual({
      endedAt: 9,
      status: "interrupted",
    });

    const idle = send(interrupted, { turn: current, type: "retire.done" });

    expect(send(idle, { at: 11, type: "interrupt" })).toBe(idle);

    const spawning = send(agentMachine.initialState, { type: "spawn.reserve" });

    expect(send(spawning, { at: 11, type: "interrupt" })).toBe(spawning);
    expect(project(spawning)).toBeNull();
  });

  it("a failed reload keeps the outcome the node had", () => {
    const idle = restore({
      endedAt: 7,
      error: "provider failed",
      model: "provider/child",
      path: "/root/worker",
      sessionFile: "/child.jsonl",
      startedAt: 1,
      status: "errored",
      thinking: "off",
      tools: [],
      usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0 },
    });

    const outcome = { endedAt: 7, error: "provider failed", status: "errored" };

    expect(idle.value).toBe("idle");
    expect(project(idle)).toStrictEqual(outcome);

    const reloading = send(idle, { type: "followup.reserve" });

    expect(reloading.value).toBe("reloading");
    expect(holdsSlot(reloading)).toBe(true);
    expect(project(reloading)).toStrictEqual(outcome);

    const failed = send(reloading, { type: "followup.failed" });

    expect(failed.value).toBe("idle");
    expect(project(failed)).toStrictEqual(outcome);

    const reloaded = send(send(failed, { type: "followup.reserve" }), {
      turn: turn(),
      type: "followup.started",
    });

    expect(reloaded.value).toBe("running");
    expect(project(reloaded)).toStrictEqual({ status: "running" });
  });
});
