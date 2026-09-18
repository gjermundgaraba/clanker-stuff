import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { Supervisor, type Task, type StartTask } from "../supervisor.js";
import { Inbox } from "../inbox.js";

const supervisors: Supervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.shutdown()));
});

function setup(concurrency = 8, history = 32) {
  const inbox = new Inbox();
  const terminal: Task[] = [];

  const supervisor = new Supervisor(
    {
      reserve: (id) => inbox.reserve(id),
      protected: (id) => inbox.protected(id),
      progress: (t, data, key) => {
        inbox.add({
          taskId: t.id,
          terminal: false,
          reason: "observation",
          data,
          ...(key !== undefined ? { key } : {}),
        });
      },
      terminal: (t, outcome) => {
        terminal.push(t);
        inbox.add({
          taskId: t.id,
          terminal: true,
          reason: outcome,
          ...(t.result !== undefined ? { data: t.result } : {}),
        });
      },
      changed: () => {},
    },
    { concurrency, history, graceMs: 100, killMs: 1000 },
  );

  supervisors.push(supervisor);

  return { supervisor, inbox, terminal };
}

const spec = (code: string, extra: Partial<StartTask> = {}): StartTask => ({
  name: "synthetic",
  command: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
  origin: "origin",
  timeoutMs: 5000,
  ...extra,
});

async function finished(task: Task) {
  await expect.poll(() => Boolean(task.cleanupPromise), { timeout: 5000 }).toBe(true);
  await task.cleanupPromise;

  return task;
}

describe("Supervisor (real subprocesses)", () => {
  it.each([
    ["console.log('ordinary'); console.error('diagnostic')", undefined, "completed"],
    ["process.exit(7)", undefined, "process_error"],
    ["process.stdout.write('')", "events-v1", "result_missing"],
    ["console.log('broken')", "events-v1", "protocol_error"],
    ["process.stdout.write('{}')", "events-v1", "protocol_error"],
    ["setInterval(()=>{},1000)", undefined, "timeout"],
    [
      "console.log(JSON.stringify({v:1,type:'result',data:{conclusion:'failure'}})); console.log('bad late data'); setInterval(()=>{},1000)",
      "events-v1",
      "result",
    ],
    [
      "for(let i=0;i<257;i++) console.log(JSON.stringify({v:1,type:'event',data:i})); setInterval(()=>{},1000)",
      "events-v1",
      "protocol_error",
    ],
  ] as const)("records %s as %s / %s", async (code, protocol, outcome) => {
    const { supervisor, terminal } = setup();

    const task = await supervisor.start(
      spec(code, { ...(protocol ? { protocol } : {}), timeoutMs: 300 }),
    );

    await finished(task);
    expect(task.outcome).toBe(outcome);
    expect(task.cleanup).toBe("clean");
    expect(terminal).toHaveLength(1);

    if (outcome === "result") expect(task.result).toEqual({ conclusion: "failure" });
    await supervisor.stop(task.id);
    expect(terminal).toHaveLength(1);
  });
  it("returns after spawn and cancellation is idempotent", async () => {
    const { supervisor, terminal } = setup();
    const task = await supervisor.start(spec("setInterval(()=>{},1000)"));
    expect(task.outcome).toBeUndefined();
    await Promise.all([supervisor.stop(task.id), supervisor.stop(task.id)]);
    expect(task.outcome).toBe("cancelled");
    expect(task.cleanup).toBe("clean");
    expect(terminal).toHaveLength(1);
  });
  it("accounts failed and cancelled startup without orphaning resources", async () => {
    const { supervisor, terminal, inbox } = setup();
    await expect(
      supervisor.start(spec("", { command: "/nonexistent/synthetic-task" })),
    ).rejects.toThrow(/did not start/);
    expect(terminal[0]).toMatchObject({ outcome: "spawn_error", cleanup: "clean" });
    const controller = new AbortController();
    controller.abort();
    await expect(supervisor.start(spec(""), controller.signal)).rejects.toThrow();
    expect(supervisor.list()).toHaveLength(1);
    const reserve = inbox.reserve.bind(inbox);
    let shutdown: Promise<void> | undefined;
    vi.spyOn(inbox, "reserve").mockImplementationOnce((id) => {
      reserve(id);
      queueMicrotask(() => {
        shutdown = supervisor.shutdown();
      });
    });
    await expect(supervisor.start(spec("setInterval(()=>{},1000)"))).rejects.toThrow(
      /did not start/,
    );
    await shutdown;
    expect(supervisor.list().at(-1)).toMatchObject({ outcome: "cancelled", cleanup: "clean" });
  });
  it.each(["absent", "alive", "permission", "child-running"] as const)(
    "reconciles failed cleanup conservatively: %s",
    async (state) => {
      const { supervisor, inbox, terminal } = setup(1);

      const task = await supervisor.start(
        spec(state === "child-running" ? "setInterval(()=>{},1000)" : "setTimeout(()=>{},100)"),
      );

      const child = task.child!;
      const pid = child.pid!;
      const nativeKill = process.kill.bind(process);
      let probing = false;

      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target !== -pid) return nativeKill(target, signal);

        if (signal !== 0) throw Object.assign(new Error("signal denied"), { code: "EPERM" });

        if (!probing || state === "alive") return true;
        throw Object.assign(new Error(state), {
          code: state === "permission" ? "EPERM" : "ESRCH",
        });
      });

      try {
        await supervisor.stop(task.id);
        expect(task.cleanup).toBe("failed");
        expect(supervisor.activeCount).toBe(1);
        expect(terminal).toHaveLength(1);
        const diagnostic = task.diagnostic;
        probing = true;
        kill.mockClear();

        if (state === "absent") {
          const next = await supervisor.start(spec("setInterval(()=>{},1000)"));
          expect(task.cleanup).toBe("clean");
          expect(supervisor.activeCount).toBe(1);
          await supervisor.stop(task.id);
          expect(next.outcome).toBeUndefined();
        } else {
          await expect(supervisor.start(spec(""))).rejects.toThrow(/Concurrent task limit/);
          await supervisor.stop(task.id);
          expect(task.cleanup).toBe("failed");
          expect(supervisor.activeCount).toBe(1);
        }

        expect(task.outcome).toBe("cancelled");
        expect(task.diagnostic).toBe(diagnostic);
        expect(terminal).toHaveLength(1);
        expect(inbox.protected(task.id)).toBe(true);
        expect(kill.mock.calls.every(([target, signal]) => target !== -pid || signal === 0)).toBe(
          true,
        );
      } finally {
        kill.mockRestore();

        if (child.exitCode === null && child.signalCode === null) {
          nativeKill(-pid, "SIGKILL");
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        }

        await supervisor.stop(task.id);
      }
    },
  );
  it("waits for the original cleanup before reconciling or pruning", async () => {
    const { supervisor, inbox, terminal } = setup(1, 0);
    const task = await supervisor.start(spec("setTimeout(()=>{},100)"));
    const nativeKill = process.kill.bind(process);
    let absent = false;

    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -task.child!.pid!) return nativeKill(pid, signal);

      if (absent) throw Object.assign(new Error("gone"), { code: "ESRCH" });

      return true;
    });

    const gate = Promise.withResolvers<void>();
    const close = task.logs!.close.bind(task.logs);

    const closeSpy = vi.spyOn(task.logs!, "close").mockImplementation(async () => {
      await gate.promise;
      await close();
    });

    try {
      const stopping = supervisor.stop(task.id);
      await expect.poll(() => closeSpy.mock.calls.length, { timeout: 3000 }).toBe(1);
      expect(task.cleanup).toBe("failed");
      absent = true;
      const admission = supervisor.start(spec("setInterval(()=>{},1000)"));
      await supervisor.prune();
      expect(supervisor.list()).toEqual([task]);
      expect(task.cleanup).toBe("failed");
      expect(terminal).toHaveLength(0);
      gate.resolve();
      await stopping;
      await admission;
      expect(task.cleanup).toBe("clean");
      expect(terminal).toHaveLength(1);
      expect(inbox.protected(task.id)).toBe(true);
    } finally {
      gate.resolve();
      kill.mockRestore();
      closeSpy.mockRestore();
    }
  });
  it("enforces admission during parallel starts", async () => {
    const { supervisor } = setup(1);

    const results = await Promise.allSettled([
      supervisor.start(spec("setInterval(()=>{},1000)")),
      supervisor.start(spec("setInterval(()=>{},1000)")),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(supervisor.activeCount).toBe(1);
  });
  it("escalates TERM-resistant parent and descendants as a process group", async () => {
    const { supervisor } = setup();
    const code = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";

    const task = await supervisor.start(
      spec(
        "const {spawn}=require('node:child_process');" +
          "process.on('SIGTERM',()=>{});" +
          "const child=spawn(process.execPath,['-e'," +
          JSON.stringify(code) +
          "],{stdio:'ignore'});" +
          "console.log(child.pid); setInterval(()=>{},1000)",
      ),
    );

    await expect.poll(() => task.logs?.read().stdout, { timeout: 2000 }).toMatch(/\d/);
    const pid = Number(task.logs!.read().stdout.trim());
    await delay(100);
    await supervisor.stop(task.id);
    expect(task.cleanup).toBe("clean");
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("claims pruning victims before concurrent filesystem cleanup", async () => {
    const { supervisor, inbox } = setup(8, 2);

    const tasks = await Promise.all(
      Array.from({ length: 4 }, async () => finished(await supervisor.start(spec("")))),
    );

    inbox.acknowledge(inbox.take()!.id);
    const first = supervisor.prune();
    expect(supervisor.list()).toHaveLength(2);
    await Promise.all([first, supervisor.prune(), supervisor.prune()]);
    expect(supervisor.evicted).toBe(2);
    expect(supervisor.list().map((task) => task.id)).toEqual(tasks.slice(2).map((task) => task.id));
  });
  it("prunes only unprotected history and removes disposable logs on shutdown", async () => {
    const { supervisor, inbox } = setup(8, 1);
    const a = await finished(await supervisor.start(spec("console.log('a')")));
    const b = await finished(await supervisor.start(spec("")));
    await supervisor.prune();
    expect(supervisor.list()).toHaveLength(2);
    const batch = inbox.take()!;
    inbox.acknowledge(batch.id);
    await supervisor.prune();
    expect(supervisor.list().map((t) => t.id)).toEqual([b.id]);
    expect(supervisor.evicted).toBe(1);
    expect(() => supervisor.get(a.id)).toThrow(/evicted/);
    await supervisor.shutdown();
    await expect(supervisor.start(spec(""))).rejects.toThrow(/shutting down/);
  });
});

it("bounds inherited-pipe drain after direct-child exit and cleans remaining descendants", async () => {
  const { supervisor } = setup();

  const task = await supervisor.start(
    spec(
      "const {spawn}=require('node:child_process');" +
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});" +
        "console.log(child.pid);child.unref();",
    ),
  );

  await finished(task);
  expect(task.outcome).toBe("completed");
  expect(task.cleanup).toBe("clean");
  const pid = Number(task.logs!.read().stdout.trim());
  expect(() => process.kill(pid, 0)).toThrow();
});
