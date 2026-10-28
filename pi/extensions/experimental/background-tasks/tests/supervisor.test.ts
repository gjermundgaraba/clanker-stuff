import { setTimeout as delay } from "node:timers/promises";

import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vite-plus/test";

import { Supervisor, unread } from "../supervisor.js";
import type { Task, StartTask, ProcessLimits } from "../supervisor.js";

const supervisors: Supervisor[] = [];

const setup = (limits: Partial<ProcessLimits> = {}) => {
  const supervisor = new Supervisor(() => {}, {
    concurrency: 8,
    history: 32,
    unread: 32,
    graceMs: 100,
    killMs: 1000,
    ...limits,
  });

  supervisors.push(supervisor);

  return supervisor;
};

const spec = (code: string, extra: Partial<StartTask> = {}): StartTask => ({
  name: "synthetic",
  command: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
  origin: "origin",
  timeoutMs: 5000,
  ...extra,
});

const finished = async (task: Task) => {
  await expect
    .poll(() => Boolean(task.cleanupPromise), { timeout: 5000 })
    .toBe(true);
  await task.cleanupPromise;

  return task;
};

const alive = (pid: number | undefined) => {
  try {
    process.kill(pid ?? 0, 0);

    return true;
  } catch {
    return false;
  }
};

const groupGone = (pid: number | undefined) => {
  try {
    process.kill(-(pid ?? 0), 0);

    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
};

describe("Supervisor (real subprocesses)", () => {
  afterEach(async () => {
    await Promise.all(
      supervisors.splice(0).map(async (s) => {
        await s.shutdown();
      })
    );
  });

  it.each([
    [
      "console.log('ordinary'); console.error('diagnostic')",
      undefined,
      "completed",
    ],
    ["process.exit(7)", undefined, "process_error"],
    ["process.stdout.write('')", "events-v1", "result_missing"],
    ["console.log('broken')", "events-v1", "protocol_error"],
    ["process.stdout.write('{}')", "events-v1", "protocol_error"],
    ["setInterval(()=>{},1000)", undefined, "timeout"],
    [
      "console.log(JSON.stringify({v:1,type:'event',key:'ci',data:'running'})); console.log(JSON.stringify({v:1,type:'result',data:{conclusion:'failure'}})); console.log('bad late data'); setInterval(()=>{},1000)",
      "events-v1",
      "result",
    ],
    [
      "for(let i=0;i<257;i++) console.log(JSON.stringify({v:1,type:'event',data:i})); setInterval(()=>{},1000)",
      "events-v1",
      "protocol_error",
    ],
  ] as const)("records %s as %s / %s", async (code, protocol, outcome) => {
    const supervisor = setup();

    const task = await supervisor.start(
      spec(code, { ...(protocol ? { protocol } : {}), timeoutMs: 300 })
    );

    expect(unread(task)?.outcome).toBeUndefined();
    await finished(task);
    expect(task.outcome).toBe(outcome);
    expect(task.cleanup).toBe("clean");
    expect(unread(task)?.outcome).toBe(outcome);

    await supervisor.stop(task.id);
    expect(task.outcome).toBe(outcome);
  });

  it("keeps the result and events reported before late invalid output", async () => {
    const supervisor = setup();

    const task = await supervisor.start(
      spec(
        "console.log(JSON.stringify({v:1,type:'event',key:'ci',data:'running'})); console.log(JSON.stringify({v:1,type:'result',data:{conclusion:'failure'}})); console.log('bad late data'); setInterval(()=>{},1000)",
        { protocol: "events-v1", timeoutMs: 300 }
      )
    );

    await finished(task);
    expect(task.outcome).toBe("result");
    expect(task.result).toStrictEqual({ conclusion: "failure" });
    expect(task.notices.events).toStrictEqual([
      { seq: 1, key: "ci", data: "running" },
    ]);
  });

  it("returns after spawn and cancellation is idempotent", async () => {
    const supervisor = setup();
    const task = await supervisor.start(spec("setInterval(()=>{},1000)"));
    expect(task.outcome).toBeUndefined();
    await Promise.all([supervisor.stop(task.id), supervisor.stop(task.id)]);
    expect(task.outcome).toBe("cancelled");
    expect(task.cleanup).toBe("clean");
  });

  it("leaves no task after a failed or cancelled start, reporting the cause", async () => {
    const supervisor = setup();
    await expect(
      supervisor.start(spec("", { command: "/nonexistent/synthetic-task" }))
    ).rejects.toThrow(
      "Task did not start (spawn_error): spawn /nonexistent/synthetic-task ENOENT"
    );
    const controller = new AbortController();
    controller.abort();
    await expect(supervisor.start(spec(""), controller.signal)).rejects.toThrow(
      "This operation was aborted"
    );
    const starting = supervisor.start(spec("setInterval(()=>{},1000)"));
    const shutdown = supervisor.shutdown();
    await expect(starting).rejects.toThrow("Task did not start (cancelled)");
    await shutdown;
    expect(supervisor.list()).toStrictEqual([]);
  });

  it("enforces admission during parallel starts", async () => {
    const supervisor = setup({ concurrency: 1 });

    const results = await Promise.allSettled([
      supervisor.start(spec("setInterval(()=>{},1000)")),
      supervisor.start(spec("setInterval(()=>{},1000)")),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(supervisor.activeCount).toBe(1);
  });

  it("blocks admission on unread outcomes and prunes only read history", async () => {
    const supervisor = setup({ history: 1, unread: 2 });
    const a = await finished(await supervisor.start(spec("")));
    const b = await finished(await supervisor.start(spec("")));
    await expect(supervisor.start(spec(""))).rejects.toThrow(
      /unread notifications/u
    );
    a.notices.clear(true);
    const c = await finished(await supervisor.start(spec("")));
    expect(supervisor.list()).toStrictEqual([a, b, c]);
    b.notices.clear(true);
    c.notices.clear(true);
    const d = await supervisor.start(spec("setInterval(()=>{},1000)"));
    expect(supervisor.list()).toStrictEqual([c, d]);
    expect(() => supervisor.get(a.id)).toThrow(/evicted/u);
  });

  it("stops and forgets discarded tasks before their cleanup completes", async () => {
    const supervisor = setup();
    const kept = await supervisor.start(spec("setInterval(()=>{},1000)"));

    const orphan = await supervisor.start(
      spec("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", {
        origin: "abandoned",
      })
    );

    const discarding = supervisor.discard(
      (task) => task.spec.origin === "abandoned"
    );

    expect(supervisor.list()).toStrictEqual([kept]);
    await discarding;
    expect(orphan).toMatchObject({ outcome: "cancelled", cleanup: "clean" });
    expect(alive(orphan.child?.pid)).toBe(false);
    expect(alive(kept.child?.pid)).toBe(true);
    expect(supervisor.list()).toStrictEqual([kept]);
  });

  it("escalates TERM-resistant parent and descendants as a process group", async () => {
    const supervisor = setup();
    const code = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";

    const task = await supervisor.start(
      spec(
        `const {spawn}=require('node:child_process');` +
          `process.on('SIGTERM',()=>{});` +
          `const child=spawn(process.execPath,['-e',${JSON.stringify(
            code
          )}],{stdio:'ignore'});` +
          `console.log(child.pid); setInterval(()=>{},1000)`
      )
    );

    await expect
      .poll(() => task.logs.read().stdout, { timeout: 2000 })
      .toMatch(/\d/u);
    const pid = Number(task.logs.read().stdout.trim());
    await delay(100);
    await supervisor.stop(task.id);
    expect(task.cleanup).toBe("clean");
    expect(alive(pid)).toBe(false);
  });

  it("checks a failed cleanup again when the task is stopped again", async () => {
    const supervisor = setup({ concurrency: 1, graceMs: 0, killMs: 0 });
    const task = await supervisor.start(spec("setInterval(()=>{},1000)"));
    await supervisor.stop(task.id);
    expect(task.cleanup).toBe("failed");
    await expect(supervisor.start(spec(""))).rejects.toThrow(
      /Concurrent task limit/u
    );

    await expect.poll(() => groupGone(task.child?.pid)).toBe(true);
    await supervisor.stop(task.id);
    expect(task.cleanup).toBe("clean");
    expect(supervisor.activeCount).toBe(0);
    await expect(supervisor.start(spec(""))).resolves.toMatchObject({
      cleanup: "pending",
    });
  });

  it("makes a stop during a failing cleanup wait for it instead of retrying it", async () => {
    const supervisor = setup({ graceMs: 0, killMs: 0 });

    const task = await supervisor.start(
      spec(
        "const {spawn}=require('node:child_process');" +
          "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,'ignore']});" +
          "console.log(child.pid); setInterval(()=>{},1000)"
      )
    );

    await expect
      .poll(() => task.logs.read().stdout, { timeout: 2000 })
      .toMatch(/\d/u);
    const escaped = Number(task.logs.read().stdout.trim());

    onTestFinished(() => {
      if (alive(escaped)) {
        process.kill(escaped, "SIGKILL");
      }
    });

    const first = supervisor.stop(task.id).then(({ cleanup }) => cleanup);
    await delay(50);
    const second = supervisor.stop(task.id).then(({ cleanup }) => cleanup);
    await expect(Promise.all([first, second])).resolves.toStrictEqual([
      "failed",
      "failed",
    ]);
  });

  it("rejects starts after shutdown", async () => {
    const supervisor = setup();
    await supervisor.shutdown();
    await expect(supervisor.start(spec(""))).rejects.toThrow(/shutting down/u);
  });

  it("bounds inherited-pipe drain after direct-child exit and cleans remaining descendants", async () => {
    const supervisor = setup();

    const task = await supervisor.start(
      spec(
        "const {spawn}=require('node:child_process');" +
          "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});" +
          "console.log(child.pid);child.unref();"
      )
    );

    await finished(task);
    expect(task.outcome).toBe("completed");
    expect(task.cleanup).toBe("clean");
    expect(alive(Number(task.logs.read().stdout.trim()))).toBe(false);
  });
});
