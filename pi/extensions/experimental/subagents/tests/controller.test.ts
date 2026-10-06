import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { SubagentsConfig } from "../config.js";
import { Controller } from "../controller.js";
import { errorCompletion } from "../prompts.js";
import { emptyTree, MAX_STATUS_TEXT } from "../protocol.js";
import type { Envelope, Mail, Tree } from "../protocol.js";
import type { ChildRuntime, ChildRuntimeRequest, ChildTurnOutcome } from "../runtime.js";
import { openTree, TreeStore } from "../store.js";

const model = fauxProvider({ models: [{ id: "child" }], provider: "provider" }).getModel();

class FakeRuntime implements ChildRuntime {
  readonly #reads: PromiseWithResolvers<boolean>[] = [];
  readonly #saved: () => Promise<Tree>;
  readonly delivered: Mail[] = [];
  /** Pending until `release()` when the test holds disposal open. */
  disposal: Promise<void> = Promise.resolve();
  readonly dispose = vi.fn<ChildRuntime["dispose"]>(() => this.disposal);
  model = "provider/child";
  readonly request: ChildRuntimeRequest;
  readonly sessionFile: string;
  readonly steered: Envelope[] = [];
  thinkingLevel: ChildRuntime["thinkingLevel"] = "off";
  readonly turns: { outcome: PromiseWithResolvers<ChildTurnOutcome>; text: string }[] = [];
  aborted = false;
  streaming = false;

  constructor(request: ChildRuntimeRequest, sessionFile: string, saved: () => Promise<Tree>) {
    this.request = request;
    this.sessionFile = request.sessionFile ?? sessionFile;
    this.#saved = saved;
  }

  abort(): void {
    this.aborted = true;
  }

  deliver(mail: Mail): void {
    this.delivered.push(mail);

    // An idle Pi session appends passive mail at once; a running one waits for the turn to end.
    if (!this.streaming) {
      this.request.onDelivered(mail.id);
    }
  }

  /** Steering reaches only a current turn, which reads it only once `read()` says so. */
  steer(task: Envelope): Promise<boolean> | undefined {
    if (!this.streaming) {
      return undefined;
    }

    this.steered.push(task);
    const read = Promise.withResolvers<boolean>();
    this.#reads.push(read);

    return read.promise;
  }

  /** Lets the current turn read every task steered into it so far. */
  read(): void {
    for (const read of this.#reads.splice(0)) {
      read.resolve(true);
    }
  }

  async startTurn(text: string): Promise<ChildTurnOutcome> {
    const outcome = Promise.withResolvers<ChildTurnOutcome>();
    this.turns.push({ outcome, text });
    this.streaming = true;

    try {
      return await outcome.promise;
    } finally {
      this.streaming = false;

      // Like the real runtime, a settled turn reports what it never read.
      for (const read of this.#reads.splice(0)) {
        read.resolve(false);
      }
    }
  }

  /** Keeps disposal pending until the returned function releases it. */
  hold(): () => void {
    const held = Promise.withResolvers<undefined>();
    this.disposal = held.promise;

    return () => held.resolve(undefined);
  }

  /** Settles the current turn and waits until the controller has started disposing it. */
  async settle(outcome: ChildTurnOutcome): Promise<void> {
    this.turns.at(-1)?.outcome.resolve(outcome);
    await vi.waitFor(() => {
      expect(this.dispose).toHaveBeenCalled();
    });
  }

  /** Settles the current turn and waits until the stored tree records its outcome. */
  async finish(outcome: ChildTurnOutcome): Promise<void> {
    await this.settle(outcome);
    await vi.waitFor(async () => {
      const node = (await this.#saved()).nodes.find(
        ({ sessionFile }) => sessionFile === this.sessionFile,
      );

      expect(node?.status).not.toBe("running");
    });
    await this.disposal;
  }
}

describe(Controller, () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "subagents-controller-"));
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  /** `startup` lists what each child session, by creation order, switches to as it starts. */
  const setup = async (
    config: SubagentsConfig = DEFAULT_CONFIG,
    tree: Tree = emptyTree(),
    startup: Partial<Pick<FakeRuntime, "model" | "thinkingLevel">>[] = [],
  ) => {
    const runtimes: FakeRuntime[] = [];
    const rootMail: Mail[] = [];
    const errors: unknown[] = [];
    const saved = async (): Promise<Tree> => (await openTree(dataDir, "root-session", true)).tree;

    const controller = new Controller({
      config,
      createRuntime: async (request) => {
        const child = createExtensionHost(request.bridge);
        await child.ready;

        const runtime = new FakeRuntime(
          request,
          path.join(dataDir, `session-${runtimes.length}.jsonl`),
          saved,
        );

        Object.assign(runtime, startup[runtimes.length]);
        await writeFile(runtime.sessionFile, "");
        runtimes.push(runtime);

        return runtime;
      },
      dataDir,
      deliverRoot: (mail) => {
        rootMail.push(mail);
      },
      onBackgroundError: (cause) => {
        errors.push(cause);
      },
      rootRunning: () => true,
    });

    const { store } = await openTree(dataDir, "root-session", true);
    await controller.open(store, tree);

    const ctx = createExtensionHost(() => {}, { model }).createContext({
      modelRegistry: {
        find: (provider, id) => (provider === "provider" && id === "child" ? model : undefined),
      },
    });

    const spawn = (taskName: string, caller = "/root", message = "work") =>
      controller.spawn(
        caller,
        {
          agentType: undefined,
          forkTurns: "none",
          message,
          model: undefined,
          taskName,
          thinking: undefined,
          tools: ["read", "spawn_agent"],
        },
        ctx,
      );

    return { controller, ctx, errors, rootMail, runtimes, saved, spawn };
  };

  it("runs a spawned task and mails its final answer to the parent", async () => {
    const { controller, errors, rootMail, runtimes, saved, spawn } = await setup();

    await expect(spawn("worker")).resolves.toStrictEqual({
      model: "provider/child",
      task_name: "/root/worker",
      thinkingLevel: "off",
    });

    const [runtime] = runtimes;
    expect(runtime?.request.tools).toStrictEqual(["read", "spawn_agent"]);
    expect(runtime?.turns[0]?.text).toBe(
      "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nwork",
    );
    expect((await saved()).nodes).toMatchObject([{ path: "/root/worker", status: "running" }]);

    await runtime?.finish({ status: "completed", text: "answer" });

    const tree = await saved();
    expect(tree.nodes).toMatchObject([{ lastAnswer: "answer", status: "completed" }]);
    expect(tree.outbox).toMatchObject([
      { content: "answer", from: "/root/worker", kind: "FINAL_ANSWER", to: "/root" },
    ]);
    expect(rootMail).toStrictEqual(tree.outbox);
    expect(controller.list("/root", undefined)).toStrictEqual([
      { agent_name: "/root", agent_status: "running" },
      { agent_name: "/root/worker", agent_status: { completed: "answer" } },
    ]);

    await controller.acknowledge(rootMail.map(({ id }) => id));
    expect((await saved()).outbox).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
  });

  it("mails a long answer in full but keeps only its start in statuses", async () => {
    const { controller, rootMail, runtimes, saved, spawn } = await setup();
    const answer = `${"a".repeat(MAX_STATUS_TEXT)}tail`;
    const cut = `${"a".repeat(MAX_STATUS_TEXT - 1)}…`;
    await spawn("worker");
    await runtimes[0]?.finish({ status: "completed", text: answer });

    expect(rootMail).toMatchObject([{ content: answer, kind: "FINAL_ANSWER" }]);
    expect((await saved()).nodes).toMatchObject([{ lastAnswer: cut }]);
    expect(controller.list("/root", "worker")).toStrictEqual([
      { agent_name: "/root/worker", agent_status: { completed: cut } },
    ]);
  });

  it("reports a failed turn to the parent with the Codex error envelope", async () => {
    const { runtimes, saved, spawn } = await setup();
    await spawn("worker");
    await runtimes[0]?.finish({ error: "provider failed", status: "errored" });

    expect(await saved()).toMatchObject({
      nodes: [{ error: "provider failed", status: "errored" }],
      outbox: [{ content: errorCompletion("provider failed"), kind: "FINAL_ANSWER" }],
    });
  });

  it("holds mail for a parent that is not running until its next task", async () => {
    const { controller, ctx, runtimes, saved, spawn } = await setup();
    await spawn("lead");
    const [lead] = runtimes;
    await spawn("scout", "/root/lead");
    const [, scout] = runtimes;
    await lead?.finish({ status: "completed", text: "lead done" });
    await scout?.finish({ status: "completed", text: "scout done" });

    const waiting = (await saved()).outbox.filter((mail) => mail.to === "/root/lead");
    expect(waiting).toMatchObject([{ content: "scout done", from: "/root/lead/scout" }]);

    await controller.followUp("/root", "lead", "continue", ctx);
    const reloaded = runtimes[2];
    expect(reloaded?.request.sessionFile).toBe(lead?.sessionFile);
    expect(reloaded?.delivered).toStrictEqual(waiting);
    expect(reloaded?.turns[0]?.text).toContain("Message Type: NEW_TASK");
    expect((await saved()).outbox.filter((mail) => mail.to === "/root/lead")).toStrictEqual([]);
  });

  it("records the model and thinking a reopened child switched to as it started", async () => {
    const { controller, ctx, runtimes, saved, spawn } = await setup(DEFAULT_CONFIG, emptyTree(), [
      {},
      { model: "provider/other", thinkingLevel: "high" },
    ]);

    await spawn("worker");
    await runtimes[0]?.finish({ status: "completed", text: "done" });

    await controller.followUp("/root", "worker", "again", ctx);
    expect((await saved()).nodes).toMatchObject([
      { model: "provider/other", status: "running", thinking: "high" },
    ]);
  });

  it("keeps mail for a running child until Pi transcribes it", async () => {
    const { controller, runtimes, saved, spawn } = await setup();
    await spawn("worker");
    const [runtime] = runtimes;

    await controller.sendMessage("/root", "worker", "context");
    const [mail] = runtime?.delivered ?? [];
    expect(mail).toMatchObject({
      content: "context",
      from: "/root",
      kind: "MESSAGE",
      to: "/root/worker",
    });
    expect((await saved()).outbox).toStrictEqual([mail]);

    runtime?.request.onDelivered(mail?.id ?? "");
    await vi.waitFor(async () => {
      expect((await saved()).outbox).toStrictEqual([]);
    });
  });

  it("steers a follow-up task into a running turn and wakes the child's wait", async () => {
    const { controller, ctx, runtimes, spawn } = await setup();
    await spawn("worker");
    const [runtime] = runtimes;
    const waiting = controller.wait("/root/worker", 10_000);

    await controller.followUp("/root", "worker", "more", ctx);
    expect(runtime?.steered).toStrictEqual([
      { content: "more", from: "/root", kind: "NEW_TASK", to: "/root/worker" },
    ]);
    await expect(waiting).resolves.toMatchObject({ message: "Wait interrupted by new input." });

    await expect(controller.followUp("/root", "/root", "self", ctx)).rejects.toThrow(
      "cannot target the root",
    );
    await expect(controller.followUp("/root", "missing", "task", ctx)).rejects.toThrow(
      "Unknown agent",
    );
  });

  it("starts a new turn for a follow-up that arrives while a turn settles", async () => {
    const { controller, ctx, runtimes, spawn } = await setup();
    await spawn("worker");
    const [settling] = runtimes;
    settling!.streaming = false;

    const following = controller.followUp("/root", "worker", "again", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtimes).toHaveLength(1);

    // Recording the outcome needs the key the follow-up held, so this deadlocks if it waits inside.
    await settling?.settle({ status: "completed", text: "done" });
    await following;

    const [, reloaded] = runtimes;
    expect(settling?.steered).toStrictEqual([]);
    expect(reloaded?.request.sessionFile).toBe(settling?.sessionFile);
    expect(reloaded?.turns[0]?.text).toContain("Payload:\nagain");
  });

  it("starts a new turn for a steered task its turn settled without reading", async () => {
    const { controller, ctx, errors, runtimes, spawn } = await setup();
    await spawn("worker");
    const [first] = runtimes;

    await controller.followUp("/root", "worker", "again", ctx);
    expect(first?.steered).toHaveLength(1);
    await first?.settle({ status: "completed", text: "done" });

    await vi.waitFor(() => {
      expect(runtimes[1]?.turns[0]?.text).toContain("Payload:\nagain");
    });
    expect(runtimes[1]?.request.sessionFile).toBe(first?.sessionFile);
    expect(errors).toStrictEqual([]);
  });

  it("does not resend a task its turn read, or one an interrupt cut short", async () => {
    const { controller, ctx, errors, runtimes, spawn } = await setup();
    await spawn("reader");
    await spawn("stopped");
    const [reader, stopped] = runtimes;

    await controller.followUp("/root", "reader", "more", ctx);
    reader?.read();
    await reader?.finish({ status: "completed" });

    await controller.followUp("/root", "stopped", "more", ctx);
    await controller.interrupt("/root", "stopped");
    stopped?.turns[0]?.outcome.resolve({ status: "interrupted" });

    // A resend would load a third runtime; give it time to appear.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimes).toHaveLength(2);
    expect(errors).toStrictEqual([]);
  });

  it("interrupts a running turn and ignores its late outcome", async () => {
    const { controller, rootMail, runtimes, saved, spawn } = await setup();
    await spawn("worker");
    const [runtime] = runtimes;

    await expect(controller.interrupt("/root", "worker")).resolves.toStrictEqual({
      previous_status: "running",
    });
    expect(runtime?.aborted).toBe(true);
    expect(runtime?.dispose).toHaveBeenCalled();

    runtime?.turns[0]?.outcome.resolve({ status: "completed", text: "late" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(await saved()).toMatchObject({ nodes: [{ status: "interrupted" }], outbox: [] });
    expect(rootMail).toStrictEqual([]);
    await expect(controller.interrupt("/root", "worker")).resolves.toStrictEqual({
      previous_status: "interrupted",
    });
    await expect(controller.interrupt("/root", "missing")).resolves.toStrictEqual({
      previous_status: "not_found",
    });
    await expect(controller.interrupt("/root/worker", "/root/worker")).rejects.toThrow(
      "cannot interrupt itself",
    );
  });

  it("limits concurrent child turns and rejects duplicate paths", async () => {
    const { runtimes, spawn } = await setup({ ...DEFAULT_CONFIG, maxConcurrent: 1 });
    await spawn("first");

    await expect(spawn("first")).rejects.toThrow("Agent already exists: /root/first");
    await expect(spawn("second")).rejects.toThrow("Subagent concurrency limit reached (1)");

    await runtimes[0]?.finish({ status: "completed" });
    await expect(spawn("second")).resolves.toMatchObject({ task_name: "/root/second" });
  });

  it("keeps a retired child's slot, session, and mail until its disposal settles", async () => {
    const { controller, ctx, runtimes, saved, spawn } = await setup({
      ...DEFAULT_CONFIG,
      maxConcurrent: 1,
    });

    await spawn("worker");
    const [retired] = runtimes;
    const release = retired!.hold();
    await retired?.settle({ status: "completed", text: "done" });

    await expect(spawn("second")).rejects.toThrow("Subagent concurrency limit reached (1)");
    await controller.sendMessage("/root", "worker", "context");
    expect(retired?.delivered).toStrictEqual([]);

    const following = controller.followUp("/root", "worker", "continue", ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtimes).toHaveLength(1);

    release();
    await following;
    const [, reloaded] = runtimes;
    expect(reloaded?.request.sessionFile).toBe(retired?.sessionFile);
    expect(reloaded?.delivered).toMatchObject([{ content: "context", kind: "MESSAGE" }]);

    const releaseReloaded = reloaded!.hold();
    await reloaded?.settle({ status: "completed" });
    let closed = false;

    const shutdown = controller.shutdown().then(() => {
      closed = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    releaseReloaded();
    await shutdown;
    expect((await saved()).nodes).toMatchObject([{ status: "completed" }]);
  });

  it("lets a cancelled follow-up stop waiting for a retiring child", async () => {
    const { controller, ctx, runtimes, spawn } = await setup();
    await spawn("worker");
    const [retired] = runtimes;
    const release = retired!.hold();
    await retired?.settle({ status: "completed", text: "done" });
    const abort = new AbortController();
    const cancelled = controller.followUp("/root", "worker", "continue", ctx, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));

    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(runtimes).toHaveLength(1);

    release();
    await controller.followUp("/root", "worker", "continue", ctx);
    expect(runtimes).toHaveLength(2);
  });

  it("discards a child whose spawn fails after its runtime started", async () => {
    const { controller, ctx, runtimes, saved } = await setup();
    const abort = new AbortController();
    abort.abort();

    await expect(
      controller.spawn(
        "/root",
        {
          agentType: undefined,
          forkTurns: "none",
          message: "work",
          model: undefined,
          taskName: "worker",
          thinking: undefined,
          tools: [],
        },
        ctx,
        abort.signal,
      ),
    ).rejects.toThrow();

    expect(runtimes[0]?.dispose).toHaveBeenCalled();
    await expect(readFile(runtimes[0]?.sessionFile ?? "")).rejects.toThrow();
    expect((await saved()).nodes).toStrictEqual([]);
  });

  it("marks agents that were running when the tree was saved as interrupted", async () => {
    const tree: Tree = {
      nodes: [
        {
          model: "provider/child",
          path: "/root/a",
          sessionFile: "/a.jsonl",
          status: "running",
          thinking: "off",
          tools: [],
        },
        {
          model: "gone/model",
          path: "/root/b",
          sessionFile: "/b.jsonl",
          status: "completed",
          thinking: "off",
          tools: [],
        },
      ],
      outbox: [],
      version: 3,
    };

    const { controller, ctx, saved } = await setup(DEFAULT_CONFIG, tree);
    expect((await saved()).nodes.map((node) => node.status)).toStrictEqual([
      "interrupted",
      "completed",
    ]);
    await expect(controller.followUp("/root", "b", "task", ctx)).rejects.toThrow(
      "Model gone/model for /root/b is no longer available",
    );
  });

  it("ignores turns from a tree that was replaced", async () => {
    const { controller, errors, rootMail, runtimes, spawn } = await setup();
    await spawn("worker");
    await controller.open(new TreeStore(undefined), emptyTree());

    expect(runtimes[0]?.dispose).toHaveBeenCalled();
    runtimes[0]?.turns[0]?.outcome.resolve({ status: "completed", text: "stale" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(controller.list("/root", undefined)).toHaveLength(1);
    expect(rootMail).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
  });

  it("does not deliver mail from a tree replaced while saving it", async () => {
    const { controller, rootMail, runtimes, spawn } = await setup();
    const gate = Promise.withResolvers<undefined>();
    let gated = false;

    class GatedStore extends TreeStore {
      override async save(tree: Tree): Promise<void> {
        if (gated) {
          await gate.promise;
        }

        await super.save(tree);
      }
    }

    await controller.open(new GatedStore(undefined), emptyTree());
    await spawn("worker");
    gated = true;
    await runtimes[0]?.settle({ status: "completed", text: "stale" });
    const opening = controller.open(new TreeStore(undefined), emptyTree());
    gate.resolve(undefined);
    await opening;
    await new Promise((resolve) => setImmediate(resolve));

    expect(rootMail).toStrictEqual([]);
  });

  describe("wait", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns at once for unread mail and wakes for new mail or input", async () => {
      const { controller } = await setup();
      await controller.sendMessage("/root", "/root", "note");
      await expect(controller.wait("/root", 10_000)).resolves.toStrictEqual({
        message: "Wait completed.",
        timed_out: false,
      });

      const waiting = controller.wait("/root", 10_000);
      await controller.sendMessage("/root", "/root", "note");
      await expect(waiting).resolves.toMatchObject({ message: "Wait completed." });

      const steered = controller.wait("/root", 10_000);
      controller.notify("/root");
      await expect(steered).resolves.toMatchObject({ message: "Wait interrupted by new input." });
    });

    it("clamps short timeouts and reports expiry", async () => {
      const { controller } = await setup();
      vi.useFakeTimers();
      const waiting = controller.wait("/root", 5);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(waiting).resolves.toStrictEqual({
        message:
          "Wait timed out.\n\nRequested timeout of 5ms was clamped to the minimum of 10000ms.",
        timed_out: true,
      });
      await expect(controller.wait("/root", 3_600_001)).rejects.toThrow("must not exceed");
    });
  });
});
