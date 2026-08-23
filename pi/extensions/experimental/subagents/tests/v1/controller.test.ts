import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import type { RoleConfig } from "../../config.js";
import { TreeCoordinator } from "../../coordinator.js";
import { NicknamePool } from "../../nicknames.js";
import type { ChildRuntimeFactory } from "../../runtime.js";
import type { ControlStore } from "../../snapshot.js";
import {
  freshSnapshot,
  createMemoryControlStore,
  rootBinding,
} from "../../snapshot.js";
import { V1Controller } from "../../v1/controller.js";
import {
  createChildContext,
  FakeChildRuntime,
} from "../fixtures/child-runtime.js";

const setup = async (maximum = 2, roles: Record<string, RoleConfig> = {}) => {
  const root = rootBinding("v1-test");
  const coordinator = new TreeCoordinator();
  await coordinator.install(
    createMemoryControlStore(),
    freshSnapshot("v1", root),
    true
  );
  const runtimes: FakeChildRuntime[] = [];
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    max_concurrent_threads_per_session: maximum,
    roles,
  };
  const prompts: string[] = [];
  const runtimeFailures: Error[] = [];
  const runtimeLoads: PromiseWithResolvers<FakeChildRuntime>[] = [];
  let nextId = 0;
  const createRuntime = vi.fn<ChildRuntimeFactory>(
    async ({ identity, prompt }) => {
      const failure = runtimeFailures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      prompts.push(prompt);
      const pending = runtimeLoads.shift();
      const runtime =
        pending === undefined
          ? new FakeChildRuntime(identity)
          : await pending.promise;
      runtimes.push(runtime);
      return runtime;
    }
  );
  const controller = new V1Controller({
    config,
    coordinator,
    createRuntime,
    dataDir: "/tmp/subagent-test",
    id: () => {
      nextId += 1;
      return `agent-${nextId}`;
    },
    nicknames: new NicknamePool(config, () => 0),
  });
  controller.setRoot(
    { getActiveTools: () => ["read", "spawn_agent"] } as ExtensionAPI,
    undefined,
    false
  );
  return {
    controller,
    coordinator,
    createRuntime,
    ctx: createChildContext(),
    prompts,
    runtimeFailures,
    runtimeLoads,
    runtimes,
  };
};

describe("V1 controller", () => {
  it("publishes pending work before starting it and atomically records completion", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    const spawned = await controller.spawn(
      { forkContext: false, message: "do work" },
      ctx
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    expect(coordinator.state).toMatchObject({
      protocolLatch: "v1",
      state: {
        agents: [
          {
            active: { input: { text: "do work" }, phase: "running" },
            id: spawned.agent_id,
            status: "running",
          },
        ],
      },
    });

    const [runtime] = runtimes;
    assert.ok(runtime);
    expect(runtime.commit).toHaveBeenCalledOnce();
    const [firstTurn] = runtime.turns;
    assert.ok(firstTurn);
    firstTurn.settled.resolve({
      status: "completed",
      text: "done",
    });
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v1"
          ? coordinator.state.state.agents[0]?.status
          : undefined
      ).toBe("completed")
    );
    expect(coordinator.state).toMatchObject({
      state: {
        agents: [{ lastAnswer: "done" }],
        notifications: [{ agentId: spawned.agent_id }],
      },
    });
    expect(
      coordinator.state.protocolLatch === "v1"
        ? coordinator.state.state.agents[0]
        : undefined
    ).not.toHaveProperty("active");
  });

  it("serializes queued inputs and enforces the open-edge cap", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup(1);
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "first" },
      ctx
    );
    await expect(
      controller.spawn({ forkContext: false, message: "overflow" }, ctx)
    ).rejects.toThrow("open-agent limit");
    await controller.sendInput(
      id,
      { interrupt: false, message: "second" },
      ctx
    );
    expect(
      coordinator.state.protocolLatch === "v1"
        ? coordinator.state.state.agents[0]?.queue
        : undefined
    ).toHaveLength(1);

    const [runtime] = runtimes;
    assert.ok(runtime);
    const [firstTurn] = runtime.turns;
    assert.ok(firstTurn);
    firstTurn.settled.resolve({ status: "completed", text: "one" });
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(2));
    const [, laterTurn] = runtime.turns;
    assert.ok(laterTurn);
    laterTurn.settled.resolve({ status: "completed", text: "two" });
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v1"
          ? coordinator.state.state.agents[0]?.lastAnswer
          : undefined
      ).toBe("two")
    );
  });

  it("does not double-count published spawn reservations", async () => {
    const { controller, ctx } = await setup(2);

    await expect(
      Promise.all([
        controller.spawn({ forkContext: false, message: "first" }, ctx),
        controller.spawn({ forkContext: false, message: "second" }, ctx),
      ])
    ).resolves.toHaveLength(2);
  });

  it("reapplies role instructions when loading a child transcript", async () => {
    const { controller, coordinator, ctx, prompts, runtimes } = await setup(2, {
      reviewer: { instructions: "Review carefully." },
    });
    const { agent_id: id } = await controller.spawn(
      {
        agentType: "reviewer",
        forkContext: false,
        message: "first",
      },
      ctx
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const firstTurn = runtimes[0]?.turns[0];
    assert.ok(firstTurn);
    firstTurn.settled.resolve({ status: "completed", text: "done" });
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v1"
          ? coordinator.state.state.agents[0]?.status
          : undefined
      ).toBe("completed")
    );
    await controller.reset();
    controller.setRoot(
      { getActiveTools: () => ["read", "spawn_agent"] } as ExtensionAPI,
      undefined,
      false
    );

    await controller.sendInput(
      id,
      { interrupt: false, message: "second" },
      ctx
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Review carefully.");
  });

  it("restores an abandoned running turn as interrupted", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    await controller.spawn({ forkContext: false, message: "work" }, ctx);
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v1"
          ? coordinator.state.state.agents[0]?.status
          : undefined
      ).toBe("running")
    );

    await controller.reset();
    controller.setRoot(
      { getActiveTools: () => ["read", "spawn_agent"] } as ExtensionAPI,
      undefined,
      false
    );
    await controller.restore(ctx);

    expect(coordinator.state).toMatchObject({
      state: {
        agents: [{ status: "interrupted" }],
      },
    });
    expect(
      coordinator.state.protocolLatch === "v1"
        ? coordinator.state.state.agents[0]
        : undefined
    ).not.toHaveProperty("active");
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]?.turns).toHaveLength(0);
  });

  it("continues restored queued work after a runtime load failure", async () => {
    const { controller, ctx, runtimeFailures, runtimes } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "first" },
      ctx
    );
    await controller.sendInput(
      id,
      { interrupt: false, message: "second" },
      ctx
    );
    runtimeFailures.push(new Error("transient restore failure"));

    await controller.reset();
    controller.setRoot(
      { getActiveTools: () => ["read", "spawn_agent"] } as ExtensionAPI,
      undefined,
      false
    );
    await controller.restore(ctx);

    await vi.waitFor(() => expect(runtimes[1]?.turns).toHaveLength(1));
    expect(runtimes[1]?.turns[0]?.input.text).toBe("second");
  });

  it("settles outstanding waits when the controller resets", async () => {
    const { controller, coordinator, ctx } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    const waiting = controller.wait([id], 10_000);
    await coordinator.barrier();

    await controller.reset();

    await expect(waiting).resolves.toMatchObject({ timed_out: false });
  });

  it("observes aborts while registering a wait", async () => {
    const { controller, ctx } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    const abort = new AbortController();
    const waiting = controller.wait([id], 10_000, abort.signal);

    queueMicrotask(() => {
      abort.abort();
    });

    await expect(waiting).rejects.toThrow("This operation was aborted");
  });

  it("does not publish send_input after cancellation during interruption", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    const [runtime] = runtimes;
    assert.ok(runtime);
    const aborting = Promise.withResolvers<null>();
    const abortRuntime = vi
      .spyOn(runtime, "abort")
      .mockImplementation(async () => {
        await aborting.promise;
      });
    const signal = new AbortController();
    const sending = controller.sendInput(
      id,
      { interrupt: true, message: "replacement" },
      ctx,
      signal.signal
    );
    void sending.catch(() => {});
    await vi.waitFor(() => expect(abortRuntime).toHaveBeenCalledOnce());

    signal.abort(new Error("cancelled"));
    aborting.resolve(null);

    await expect(sending).rejects.toThrow("cancelled");
    expect(coordinator.state).toMatchObject({
      state: {
        agents: [
          {
            active: { input: { text: "work" } },
            queue: [],
          },
        ],
      },
    });
  });

  it("does not publish send_input after cancellation in the coordinator queue", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    await coordinator.barrier();

    const writeStarted = Promise.withResolvers<null>();
    const releaseWrite = Promise.withResolvers<null>();
    const empty: Awaited<ReturnType<ControlStore["load"]>> = undefined;
    const successful: Awaited<ReturnType<ControlStore["write"]>> = undefined;
    let blockNextWrite = true;
    const store: ControlStore = {
      load: () => Promise.resolve(empty),
      persistent: false,
      write: async (_serialized, onCommit) => {
        if (blockNextWrite) {
          blockNextWrite = false;
          writeStarted.resolve(null);
          await releaseWrite.promise;
        }
        onCommit();
        return successful;
      },
    };
    await coordinator.install(store, structuredClone(coordinator.state), false);
    const blocking = coordinator.transact(() => null);
    await writeStarted.promise;
    const transact = vi.spyOn(coordinator, "transact");

    const signal = new AbortController();
    const sending = controller.sendInput(
      id,
      { interrupt: false, message: "replacement" },
      ctx,
      signal.signal
    );
    void sending.catch(() => {});
    await vi.waitFor(() => expect(transact).toHaveBeenCalledOnce());

    signal.abort(new Error("cancelled"));
    releaseWrite.resolve(null);
    await blocking;

    await expect(sending).rejects.toThrow("cancelled");
    expect(coordinator.state).toMatchObject({
      state: {
        agents: [
          {
            active: { input: { text: "work" } },
            queue: [],
          },
        ],
      },
    });
  });

  it("waits for provisional spawn creation during shutdown", async () => {
    const { controller, createRuntime, ctx, runtimeLoads } = await setup();
    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const spawning = controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    void spawning.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

    let stopped = false;
    const shutdown = controller.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalsy();
    await expect(
      controller.spawn({ forkContext: false, message: "late work" }, ctx)
    ).rejects.toThrow("Subagent controller is shutting down");
    expect(createRuntime).toHaveBeenCalledOnce();

    const runtime = new FakeChildRuntime("agent-1");
    pending.resolve(runtime);
    await shutdown;

    await expect(spawning).rejects.toThrow("Stale V1 controller operation");
    expect(runtime.rollback).toHaveBeenCalledOnce();
  });

  it("keeps spawn admission closed until reset quiesces", async () => {
    const { controller, createRuntime, ctx, runtimeLoads } = await setup();
    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const spawning = controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    void spawning.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

    const reset = controller.reset();
    await expect(
      controller.spawn({ forkContext: false, message: "late work" }, ctx)
    ).rejects.toThrow("Subagent controller is shutting down");

    const staleRuntime = new FakeChildRuntime("agent-1");
    pending.resolve(staleRuntime);
    await reset;
    await expect(spawning).rejects.toThrow("Stale V1 controller operation");
    expect(staleRuntime.rollback).toHaveBeenCalledOnce();

    await expect(
      controller.spawn({ forkContext: false, message: "new work" }, ctx)
    ).resolves.toMatchObject({ agent_id: "agent-2" });
  });

  it("waits for an in-flight runtime load during shutdown", async () => {
    const { controller, createRuntime, ctx, runtimeLoads, runtimes } =
      await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    await controller.reset();
    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const sending = controller.sendInput(
      id,
      { interrupt: false, message: "later" },
      ctx
    );
    void sending.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));

    let stopped = false;
    const shutdown = controller.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalsy();

    const staleRuntime = new FakeChildRuntime(id);
    pending.resolve(staleRuntime);
    await shutdown;
    await expect(sending).rejects.toThrow("Stale V1 runtime load");
    expect(staleRuntime.dispose).toHaveBeenCalledOnce();
    expect(runtimes).toContain(staleRuntime);
  });

  it("advances the FIFO after a turn fails", async () => {
    const { controller, ctx, runtimes } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "first" },
      ctx
    );
    await controller.sendInput(
      id,
      { interrupt: false, message: "second" },
      ctx
    );
    const [runtime] = runtimes;
    assert.ok(runtime);
    const [firstTurn] = runtime.turns;
    assert.ok(firstTurn);

    firstTurn.settled.reject(new Error("first failed"));

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    const [, secondTurn] = runtime.turns;
    assert.ok(secondTurn);
    expect(secondTurn.input.text).toBe("second");
  });

  it("closes a known agent without reloading it", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );
    const result = await controller.close(id, ctx);
    expect(result.previous_status).toBe("running");
    expect(runtimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(coordinator.state).toMatchObject({
      state: { agents: [{ edge: "closed", status: "shutdown" }] },
    });
  });

  it("serializes the observed status of concurrent closes", async () => {
    const { controller, ctx } = await setup();
    const { agent_id: id } = await controller.spawn(
      { forkContext: false, message: "work" },
      ctx
    );

    const [first, second] = await Promise.all([
      controller.close(id, ctx),
      controller.close(id, ctx),
    ]);

    expect(first.previous_status).toBe("running");
    expect(second.previous_status).toBe("shutdown");
  });
});
