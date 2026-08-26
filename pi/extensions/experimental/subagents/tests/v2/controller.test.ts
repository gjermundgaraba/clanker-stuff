import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../../config.js";
import type { RoleConfig } from "../../config.js";
import { COLLABORATION_CONTRACT_REQUEST } from "../../contract.js";
import type { CollaborationContract } from "../../contract.js";
import { TreeCoordinator } from "../../coordinator.js";
import { NicknamePool } from "../../nicknames.js";
import { PermanentChildError } from "../../permanent-error.js";
import type { ChildRuntimeFactory } from "../../runtime.js";
import { freshSnapshot, createMemoryControlStore, rootBinding } from "../../snapshot.js";
import { V2Controller } from "../../v2/controller.js";
import { createChildContext, FakeChildRuntime } from "../fixtures/child-runtime.js";

const setup = async (
  maximum = 3,
  roles: Record<string, RoleConfig> = {},
  failPersistence = false,
  bridgeChildren = false,
) => {
  const root = rootBinding("v2-test");
  const coordinator = new TreeCoordinator();
  await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), true);
  const runtimes: FakeChildRuntime[] = [];
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    max_concurrent_threads_per_session: maximum,
    roles,
  };
  const prompts: string[] = [];
  const childHosts: ReturnType<typeof createExtensionHost>[] = [];
  const runtimeLoads: PromiseWithResolvers<FakeChildRuntime>[] = [];
  const createRuntime = vi.fn<ChildRuntimeFactory>(async ({ bridge, identity, prompt }) => {
    prompts.push(prompt);
    if (bridgeChildren) {
      const host = createExtensionHost(bridge, { sessionId: identity });
      await host.ready;
      await host.emitSessionStart();
      childHosts.push(host);
    }
    const pending = runtimeLoads.shift();
    const runtime = pending === undefined ? new FakeChildRuntime(identity) : await pending.promise;
    runtime.failPersistence = failPersistence;
    runtimes.push(runtime);
    return runtime;
  });
  const controller = new V2Controller({
    config,
    coordinator,
    createRuntime,
    dataDir: "/tmp/subagent-test",
    id: (() => {
      let next = 0;
      return () => {
        next += 1;
        return `communication-${next}`;
      };
    })(),
    nicknames: new NicknamePool(config, () => 0),
  });
  controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);
  return {
    controller,
    childHosts,
    coordinator,
    createRuntime,
    ctx: createChildContext(),
    prompts,
    runtimeLoads,
    runtimes,
  };
};

describe("V2 controller", () => {
  it("publishes task intent, accepts it, and commits terminal state with parent mail", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    const spawned = await controller.spawn(
      "/root",
      {
        forkTurns: "none",
        message: "work",
        taskName: "worker",
      },
      ctx,
    );
    expect(spawned.task_name).toBe("/root/worker");
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    expect(coordinator.state).toMatchObject({
      state: { nodes: [{ path: "/root/worker", status: "running" }] },
    });

    const [runtime] = runtimes;
    assert.ok(runtime);
    expect(runtime.commit).toHaveBeenCalledOnce();
    const [turn] = runtime.turns;
    assert.ok(turn);
    turn.settled.resolve({
      status: "completed",
      text: "done",
    });
    await vi.waitFor(() => expect(controller.rootDeliveries()).toHaveLength(1));
    expect(coordinator.state).toMatchObject({
      state: {
        communications: [
          {
            content: "done",
            from: "/root/worker",
            kind: "FINAL_ANSWER",
            to: "/root",
          },
        ],
        nodes: [
          {
            lastAnswer: "done",
            status: "completed",
          },
        ],
      },
    });
  });

  it("loads and durably accepts queue-only mail", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    await controller.sendMessage("/root", "worker", "context", ctx);
    await vi.waitFor(() => expect(runtimes[0]?.calls).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v2"
          ? coordinator.state.state.communications.some(({ content }) => content === "context")
          : true,
      ).toBeFalsy(),
    );
  });

  it("quarantines a transcript persistence failure instead of retrying forever", async () => {
    vi.useFakeTimers();
    try {
      const { controller, ctx, runtimes } = await setup();
      await controller.spawn(
        "/root",
        { forkTurns: "none", message: "work", taskName: "worker" },
        ctx,
      );
      await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
      const [runtime] = runtimes;
      assert.ok(runtime);
      runtime.failPersistence = true;

      await controller.sendMessage("/root", "worker", "context", ctx);
      await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(runtimes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a follow-up turn when the prior turn settles before delivery", async () => {
    const { controller, ctx, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const [runtime] = runtimes;
    assert.ok(runtime);
    runtime.beforeSendMessage = () => {
      runtime.turns[0]?.settled.resolve({
        status: "completed",
        text: "first done",
      });
      runtime.streaming = false;
    };

    await controller.followUp("/root", "worker", "more work", ctx);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(runtime.calls).toHaveLength(1);
    runtime.turns[1]?.settled.resolve({
      status: "completed",
      text: "second done",
    });
    await vi.waitFor(() =>
      expect(controller.list("/root")[1]).toMatchObject({
        lastAnswer: "second done",
        status: "completed",
      }),
    );
  });

  it("publishes a terminal error when turn acceptance fails", async () => {
    const { controller, coordinator, ctx } = await setup(3, {}, true);

    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );

    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v2"
          ? coordinator.state.state.nodes[0]?.status
          : undefined,
      ).toBe("errored"),
    );
    expect(controller.rootDeliveries()).toHaveLength(1);
  });

  it("uses an empty completion payload when the child returns no text", async () => {
    const { controller, ctx, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const turn = runtimes[0]?.turns[0];
    assert.ok(turn);

    turn.settled.resolve({ status: "completed" });

    await vi.waitFor(() => expect(controller.rootDeliveries()).toHaveLength(1));
    expect(controller.rootDeliveries()[0]?.content).toBe("");
  });

  it("restores an abandoned running turn as interrupted", async () => {
    const { controller, coordinator, ctx, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v2"
          ? coordinator.state.state.nodes[0]?.status
          : undefined,
      ).toBe("running"),
    );

    await controller.reset();
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);
    await controller.restore(ctx);

    expect(coordinator.state).toMatchObject({
      state: {
        nodes: [{ status: "interrupted" }],
      },
    });
    expect(
      coordinator.state.protocolLatch === "v2" ? coordinator.state.state.nodes[0] : {},
    ).not.toHaveProperty("activeDeliveryId");
    expect(runtimes).toHaveLength(1);
  });

  it("drains deliverable restored mail after one target fails to load", async () => {
    const root = rootBinding("v2-restored-mail");
    const coordinator = new TreeCoordinator();
    const snapshot = freshSnapshot("v2", root);
    assert.equal(snapshot.protocolLatch, "v2");
    for (const name of ["first", "second", "third"]) {
      const pathname = `/root/${name}`;
      snapshot.nicknames.push(name);
      snapshot.state.nodes.push({
        nickname: name,
        path: pathname,
        sessionFile: `/tmp/subagent-test/sessions/${name}.jsonl`,
        status: "completed",
        tools: [],
      });
      snapshot.state.communications.push({
        content: `${name} message`,
        delivery: "queue",
        from: "/root",
        id: `${name}-message`,
        kind: "MESSAGE",
        to: pathname,
      });
    }
    await coordinator.install(createMemoryControlStore(), snapshot, true);
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      max_concurrent_threads_per_session: 1,
    };
    const runtimes: FakeChildRuntime[] = [];
    const attempts: string[] = [];
    let firstAttempts = 0;
    const controller = new V2Controller({
      config,
      coordinator,
      createRuntime: async ({ identity }) => {
        attempts.push(identity);
        if (identity === "/root/first") {
          firstAttempts += 1;
          if (firstAttempts === 1) {
            throw new Error("first transcript unavailable");
          }
        }
        const runtime = new FakeChildRuntime(identity);
        runtimes.push(runtime);
        return runtime;
      },
      dataDir: "/tmp/subagent-test",
      nicknames: new NicknamePool(config, () => 0),
    });
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);

    await controller.restore(createChildContext());

    await vi.waitFor(() => expect(runtimes).toHaveLength(3));
    expect(attempts).toStrictEqual(["/root/first", "/root/second", "/root/third", "/root/first"]);
    expect(runtimes.map(({ calls }) => calls[0]?.content)).toStrictEqual([
      expect.stringContaining("second message"),
      expect.stringContaining("third message"),
      expect.stringContaining("first message"),
    ]);
    expect(coordinator.state).toMatchObject({
      state: { communications: [] },
    });
  });

  it("releases a failed lazy-load slot so delivery can retry", async () => {
    const root = rootBinding("v2-load-retry");
    const coordinator = new TreeCoordinator();
    const snapshot = freshSnapshot("v2", root);
    assert.equal(snapshot.protocolLatch, "v2");
    snapshot.nicknames.push("Worker");
    snapshot.state.nodes.push({
      nickname: "Worker",
      path: "/root/worker",
      sessionFile: "/tmp/subagent-test/sessions/worker.jsonl",
      status: "interrupted",
      tools: [],
    });
    await coordinator.install(createMemoryControlStore(), snapshot, true);
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      max_concurrent_threads_per_session: 1,
    };
    let attempts = 0;
    const runtime = new FakeChildRuntime("/root/worker");
    const controller = new V2Controller({
      config,
      coordinator,
      createRuntime: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("load failed");
        }
        return runtime;
      },
      dataDir: "/tmp/subagent-test",
      nicknames: new NicknamePool(config, () => 0),
    });
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);
    const ctx = createChildContext();

    await expect(controller.sendMessage("/root", "worker", "first", ctx)).rejects.toThrow(
      "load failed",
    );
    await controller.sendMessage("/root", "worker", "second", ctx);

    expect(attempts).toBe(2);
    expect(runtime.calls).toHaveLength(1);
  });

  it("does not retry a permanently invalid restored session", async () => {
    vi.useFakeTimers();
    try {
      const root = rootBinding("v2-permanent-restore-error");
      const coordinator = new TreeCoordinator();
      const snapshot = freshSnapshot("v2", root);
      assert.equal(snapshot.protocolLatch, "v2");
      snapshot.nicknames.push("Worker");
      snapshot.state.nodes.push({
        nickname: "Worker",
        path: "/root/worker",
        sessionFile: "/tmp/subagent-test/sessions/worker.jsonl",
        status: "interrupted",
        tools: [],
      });
      snapshot.state.communications.push({
        content: "resume",
        delivery: "queue",
        from: "/root",
        id: "restore-message",
        kind: "MESSAGE",
        to: "/root/worker",
      });
      await coordinator.install(createMemoryControlStore(), snapshot, true);
      let attempts = 0;
      const controller = new V2Controller({
        config: {
          ...structuredClone(DEFAULT_CONFIG),
          max_concurrent_threads_per_session: 1,
        },
        coordinator,
        createRuntime: async () => {
          attempts += 1;
          throw new PermanentChildError("invalid child transcript");
        },
        dataDir: "/tmp/subagent-test",
        nicknames: new NicknamePool(DEFAULT_CONFIG, () => 0),
      });
      controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);

      await controller.restore(createChildContext());
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds residency capacity until physical disposal finishes", async () => {
    const { controller, ctx, runtimes } = await setup(1);
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "first", taskName: "first" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const [runtime] = runtimes;
    assert.ok(runtime);
    const [turn] = runtime.turns;
    assert.ok(turn);
    const disposal = Promise.withResolvers<undefined>();
    runtime.dispose.mockReturnValue(disposal.promise);
    turn.settled.resolve({ status: "completed", text: "done" });
    await vi.waitFor(() => expect(controller.rootDeliveries()).toHaveLength(1));

    await expect(
      controller.spawn("/root", { forkTurns: "none", message: "second", taskName: "second" }, ctx),
    ).rejects.toThrow("residency limit");

    disposal.resolve(undefined);
    await vi.waitFor(() =>
      expect(
        controller.list("/root").find(({ path }) => path === "/root/first")?.resident,
      ).toBeFalsy(),
    );
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "second", taskName: "second" },
      ctx,
    );
  });

  it("does not double-count published execution reservations", async () => {
    const { controller, ctx } = await setup(2);

    await expect(
      Promise.all([
        controller.spawn("/root", { forkTurns: "none", message: "first", taskName: "first" }, ctx),
        controller.spawn(
          "/root",
          { forkTurns: "none", message: "second", taskName: "second" },
          ctx,
        ),
      ]),
    ).resolves.toHaveLength(2);
  });

  it("rejects concurrent spawns for the same path before creating twice", async () => {
    const { controller, ctx, runtimes } = await setup();
    const first = controller.spawn(
      "/root",
      { forkTurns: "none", message: "first", taskName: "worker" },
      ctx,
    );
    await expect(
      controller.spawn("/root", { forkTurns: "none", message: "second", taskName: "worker" }, ctx),
    ).rejects.toThrow("Agent is already being created: /root/worker");
    await first;

    expect(runtimes).toHaveLength(1);
  });

  it("releases nickname and residency claims after runtime creation fails", async () => {
    const root = rootBinding("v2-reservation-release");
    const coordinator = new TreeCoordinator();
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), true);
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      max_concurrent_threads_per_session: 1,
    };
    const runtime = new FakeChildRuntime("/root/second");
    let attempts = 0;
    const controller = new V2Controller({
      config,
      coordinator,
      createRuntime: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("creation failed");
        }
        return runtime;
      },
      dataDir: "/tmp/subagent-test",
      nicknames: new NicknamePool(config, () => 0),
    });
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);
    const ctx = createChildContext();

    await expect(
      controller.spawn("/root", { forkTurns: "none", message: "first", taskName: "first" }, ctx),
    ).rejects.toThrow("creation failed");
    await expect(
      controller.spawn("/root", { forkTurns: "none", message: "second", taskName: "second" }, ctx),
    ).resolves.toMatchObject({ nickname: "Atlas" });

    expect(attempts).toBe(2);
  });

  it("redrains queued mail when a failed spawn releases residency", async () => {
    const { controller, coordinator, createRuntime, ctx, runtimeLoads, runtimes } = await setup(1);
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const firstTurn = runtimes[0]?.turns[0];
    assert.ok(firstTurn);
    firstTurn.settled.resolve({ status: "completed", text: "done" });
    await vi.waitFor(() =>
      expect(
        controller.list("/root").find(({ path }) => path === "/root/worker")?.resident,
      ).toBeFalsy(),
    );

    const failedDelivery = new FakeChildRuntime("/root/worker");
    vi.spyOn(failedDelivery, "sendMessage").mockReturnValue({
      accepted: Promise.reject(new Error("transient delivery failure")),
    });
    const failedLoad = Promise.withResolvers<FakeChildRuntime>();
    failedLoad.resolve(failedDelivery);
    runtimeLoads.push(failedLoad);
    await controller.sendMessage("/root", "worker", "queued context", ctx);
    await vi.waitFor(() => expect(failedDelivery.dispose).toHaveBeenCalledOnce());

    const blockedSpawn = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(blockedSpawn);
    const spawning = controller.spawn(
      "/root",
      { forkTurns: "none", message: "block", taskName: "blocker" },
      ctx,
    );
    void spawning.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(3));
    await delay(300);
    expect(createRuntime).toHaveBeenCalledTimes(3);

    blockedSpawn.reject(new Error("spawn failed"));
    await expect(spawning).rejects.toThrow("spawn failed");
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(4));
    await vi.waitFor(() =>
      expect(
        coordinator.state.protocolLatch === "v2"
          ? coordinator.state.state.communications.some(
              ({ content }) => content === "queued context",
            )
          : true,
      ).toBeFalsy(),
    );
  });

  it("rolls back a spawn aborted during runtime creation", async () => {
    const root = rootBinding("v2-aborted-spawn");
    const coordinator = new TreeCoordinator();
    await coordinator.install(createMemoryControlStore(), freshSnapshot("v2", root), true);
    const config = structuredClone(DEFAULT_CONFIG);
    const runtimeReady = Promise.withResolvers<FakeChildRuntime>();
    const controller = new V2Controller({
      config,
      coordinator,
      createRuntime: () => runtimeReady.promise,
      dataDir: "/tmp/subagent-test",
      nicknames: new NicknamePool(config, () => 0),
    });
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);
    const abort = new AbortController();
    const spawning = controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      createChildContext(),
      abort.signal,
    );
    abort.abort(new Error("cancelled"));
    const runtime = new FakeChildRuntime("/root/worker");
    runtimeReady.resolve(runtime);

    await expect(spawning).rejects.toThrow("cancelled");
    expect(runtime.commit).not.toHaveBeenCalled();
    expect(runtime.rollback).toHaveBeenCalledOnce();
    expect(controller.list("/root")).toHaveLength(1);
  });

  it("waits for provisional spawn creation during shutdown", async () => {
    const { controller, createRuntime, ctx, runtimeLoads } = await setup();
    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const spawning = controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
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
      controller.spawn("/root", { forkTurns: "none", message: "late work", taskName: "late" }, ctx),
    ).rejects.toThrow("Subagent controller is shutting down");
    expect(createRuntime).toHaveBeenCalledOnce();

    const runtime = new FakeChildRuntime("/root/worker");
    pending.resolve(runtime);
    await shutdown;

    await expect(spawning).rejects.toThrow("Stale child spawn");
    expect(runtime.rollback).toHaveBeenCalledOnce();
  });

  it("keeps spawn admission closed until reset quiesces", async () => {
    const { controller, createRuntime, ctx, runtimeLoads } = await setup();
    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const spawning = controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    void spawning.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

    const reset = controller.reset();
    await expect(
      controller.spawn("/root", { forkTurns: "none", message: "late work", taskName: "late" }, ctx),
    ).rejects.toThrow("Subagent controller is shutting down");

    const staleRuntime = new FakeChildRuntime("/root/worker");
    pending.resolve(staleRuntime);
    await reset;
    await expect(spawning).rejects.toThrow("Stale child spawn");
    expect(staleRuntime.rollback).toHaveBeenCalledOnce();

    await expect(
      controller.spawn(
        "/root",
        { forkTurns: "none", message: "new work", taskName: "worker" },
        ctx,
      ),
    ).resolves.toMatchObject({ task_name: "/root/worker" });
  });

  it("waits for an in-flight runtime load during shutdown", async () => {
    const { controller, createRuntime, ctx, runtimeLoads, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "first", taskName: "worker" },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const firstTurn = runtimes[0]?.turns[0];
    assert.ok(firstTurn);
    firstTurn.settled.resolve({ status: "completed", text: "done" });
    await vi.waitFor(() =>
      expect(
        controller.list("/root").find(({ path }) => path === "/root/worker")?.resident,
      ).toBeFalsy(),
    );

    const pending = Promise.withResolvers<FakeChildRuntime>();
    runtimeLoads.push(pending);
    const following = controller.followUp("/root", "worker", "later", ctx);
    void following.catch(() => {});
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));

    let stopped = false;
    const shutdown = controller.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalsy();

    const staleRuntime = new FakeChildRuntime("/root/worker");
    pending.resolve(staleRuntime);
    await shutdown;
    await expect(following).rejects.toThrow("Stale child runtime load");
    expect(staleRuntime.dispose).toHaveBeenCalledOnce();
  });

  it("reapplies role instructions when loading a retired child", async () => {
    const { controller, ctx, prompts, runtimes } = await setup(3, {
      reviewer: { instructions: "Review carefully." },
    });
    await controller.spawn(
      "/root",
      {
        agentType: "reviewer",
        forkTurns: "none",
        message: "first",
        taskName: "worker",
      },
      ctx,
    );
    await vi.waitFor(() => expect(runtimes[0]?.turns).toHaveLength(1));
    const firstTurn = runtimes[0]?.turns[0];
    assert.ok(firstTurn);
    firstTurn.settled.resolve({ status: "completed", text: "done" });
    await vi.waitFor(() => expect(controller.list("/root")[1]?.resident).toBeFalsy());

    await controller.followUp("/root", "worker", "second", ctx);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Review carefully.");
    await vi.waitFor(() =>
      expect(controller.list("/root")[1]).toMatchObject({
        lastAnswer: "done",
        status: "running",
      }),
    );
  });

  it("preserves role thinking instead of inheriting Ultra", async () => {
    const { childHosts, controller, ctx } = await setup(
      3,
      { reviewer: { thinking: "high" } },
      false,
      true,
    );
    controller.setUltra("/root", true);

    await controller.spawn(
      "/root",
      {
        agentType: "reviewer",
        forkTurns: "none",
        message: "review",
        taskName: "reviewer",
      },
      ctx,
    );

    let contract: CollaborationContract | undefined;
    childHosts[0]?.events.emit(COLLABORATION_CONTRACT_REQUEST, {
      provide: (value: CollaborationContract) => {
        contract = value;
      },
      sessionId: "/root/reviewer",
    });
    expect(contract?.inheritedUltra).toBe(false);
  });

  it("interrupts a pending child before its runtime loads", async () => {
    const root = rootBinding("v2-pending-interrupt");
    const coordinator = new TreeCoordinator();
    const snapshot = freshSnapshot("v2", root);
    assert.equal(snapshot.protocolLatch, "v2");
    snapshot.nicknames.push("Worker");
    snapshot.state.nodes.push({
      activeDeliveryId: "task",
      nickname: "Worker",
      path: "/root/worker",
      sessionFile: "/tmp/subagent-test/sessions/worker.jsonl",
      status: "pending",
      tools: [],
    });
    snapshot.state.communications.push({
      content: "work",
      delivery: "turn",
      from: "/root",
      id: "task",
      kind: "NEW_TASK",
      to: "/root/worker",
    });
    await coordinator.install(createMemoryControlStore(), snapshot, true);
    const config = structuredClone(DEFAULT_CONFIG);
    const controller = new V2Controller({
      config,
      coordinator,
      createRuntime: async () => {
        throw new Error("runtime should not load");
      },
      dataDir: "/tmp/subagent-test",
      nicknames: new NicknamePool(config, () => 0),
    });
    controller.setRoot({ getActiveTools: () => ["read"] }, undefined, false);

    await expect(controller.interrupt("/root", "worker")).resolves.toStrictEqual({
      previous_status: "pending_init",
    });
    expect(coordinator.state).toMatchObject({
      state: {
        communications: [],
        nodes: [{ status: "interrupted" }],
      },
    });
  });

  it("does not interrupt after cancellation while waiting for the target queue", async () => {
    const { controller, ctx, runtimes } = await setup();
    await controller.spawn(
      "/root",
      { forkTurns: "none", message: "work", taskName: "worker" },
      ctx,
    );
    const [runtime] = runtimes;
    assert.ok(runtime);
    const delivery = Promise.withResolvers<undefined>();
    const sendMessage = vi.spyOn(runtime, "sendMessage").mockReturnValue({
      accepted: delivery.promise,
    });
    const abortRuntime = vi.spyOn(runtime, "abort");
    await controller.sendMessage("/root", "worker", "context", ctx);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    const abort = new AbortController();
    const interrupting = controller.interrupt("/root", "worker", abort.signal);
    void interrupting.catch(() => {});
    abort.abort(new Error("cancelled"));
    delivery.resolve(undefined);

    await expect(interrupting).rejects.toThrow("cancelled");
    expect(abortRuntime).not.toHaveBeenCalled();
    expect(controller.list("/root").find(({ path }) => path === "/root/worker")?.status).toBe(
      "running",
    );
  });

  it("subscribes before checking mailbox activity", async () => {
    vi.useFakeTimers();
    try {
      const { controller } = await setup();
      controller.notify("/root");
      const waiting = controller.wait("/root", 10_000);
      await Promise.resolve();
      controller.notify("/root");
      await expect(waiting).resolves.toMatchObject({ timed_out: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports when a requested wait is clamped", async () => {
    const { controller, coordinator } = await setup();
    const waiting = controller.wait("/root", 1);
    await coordinator.barrier();
    controller.notify("/root");

    await expect(waiting).resolves.toStrictEqual({
      message:
        "Wait interrupted by new input.\n\nRequested timeout of 1ms was clamped to the minimum of 10000ms.",
      timed_out: false,
    });
  });

  it("settles outstanding waits when the controller resets", async () => {
    const { controller, coordinator } = await setup();
    const waiting = controller.wait("/root", 10_000);
    await coordinator.barrier();

    await controller.reset();

    await expect(waiting).resolves.toStrictEqual({
      message: "Wait interrupted by new input.",
      timed_out: false,
    });
  });

  it("observes aborts while registering a wait", async () => {
    const { controller } = await setup();
    const abort = new AbortController();
    const waiting = controller.wait("/root", 10_000, abort.signal);

    queueMicrotask(() => {
      abort.abort();
    });

    await expect(waiting).rejects.toThrow("This operation was aborted");
  });
});
