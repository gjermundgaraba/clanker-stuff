import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { TaskRuntime } from "../runtime.js";
import { registerTaskTools } from "../register.js";

const runtimes: TaskRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

async function setup(
  code = "for (const data of [1,2]) console.log(JSON.stringify({v:1,type:'event',data}));console.log(JSON.stringify({v:1,type:'result',data:'done'}))",
) {
  let runtime!: TaskRuntime;

  const host = createExtensionHost(
    (pi) => {
      runtime = new TaskRuntime(pi);
      registerTaskTools(pi, runtime);
      pi.registerCommand("tasks", {
        description: "Tasks",
        handler: (args, ctx) => runtime.command(args, ctx),
      });
    },
    { leafId: "origin" },
  );

  await host.ready;
  runtimes.push(runtime);
  // Keep delivery out of these tool-boundary tests, without disabling capture.
  const ctx = host.createContext({ mode: "tui", isIdle: () => false });
  runtime.startSession(ctx);
  await host.emitSessionStart(ctx);

  const task = await runtime.supervisor.start({
    name: "fixture",
    command: process.execPath,
    args: ["-e", code],
    cwd: ctx.cwd,
    origin: "origin",
    protocol: "events-v1",
  });

  return { host, runtime, task, ctx };
}

async function completed() {
  const s = await setup();
  await expect.poll(() => s.task.outcome).toBe("result");
  await s.task.cleanupPromise;
  expect(s.runtime.inbox.count).toBe(3);

  return s;
}

describe("targeted task-tool consumption", () => {
  it("keeps human and shared reads pure, but consumes all IDs in an agent summary", async () => {
    const { host, runtime, task, ctx } = await completed();
    const events = runtime.inbox.lookup(task.id);
    runtime.inspect({ id: task.id, view: "summary" }, "observe");
    await host.runCommand("tasks", "", ctx);
    await host.runCommand("tasks", `inspect ${task.id}`, ctx);
    await host.runTool("task_list", {}, ctx);
    expect(runtime.inbox.count).toBe(3);
    expect(runtime.inbox.protected(task.id)).toBe(true);
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, ctx);
    expect(response.details).toMatchObject({ events: events.map(({ id }) => ({ id })) });
    expect(runtime.inbox.count).toBe(0);
    expect(runtime.inbox.protected(task.id)).toBe(false);
    expect(runtime.inbox.lookup(task.id)).toEqual(events);
    await host.runTool("task_inspect", { id: task.id, view: "summary" }, ctx);
    expect(runtime.inbox.protected(task.id)).toBe(false);
  });

  it("keeps all 65 discovered events readable after summary consumption", async () => {
    const { host, runtime, task, ctx } = await setup(
      "for (let data=0;data<64;data++) console.log(JSON.stringify({v:1,type:'event',data}));" +
        "console.log(JSON.stringify({v:1,type:'result',data:'done'}))",
    );

    await expect.poll(() => task.outcome).toBe("result");
    await task.cleanupPromise;
    const events = runtime.inbox.lookup(task.id);
    expect(events).toHaveLength(65);
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, ctx);
    expect(response.details).toMatchObject({ events: events.map(({ id }) => ({ id })) });
    expect(runtime.inbox.count).toBe(0);
    const [first] = events;
    assert.ok(first);

    const oldest = await host.runTool(
      "task_inspect",
      { id: task.id, view: "event", eventId: first.id },
      ctx,
    );

    expect(oldest.details).toMatchObject({ payload: { text: "0", nextOffset: null } });
    expect(runtime.inbox.lookup(task.id)).toEqual(events);
    expect(runtime.inbox.evicted).toBe(0);
  });

  it("finishes an older event's pages with a full newer retired history", async () => {
    const { host, runtime, task, ctx } = await setup("setInterval(()=>{},1000)");
    // This fits a watcher record as 1e20 literals, but expands past one tool page.
    const data = Array.from({ length: 2500 }, () => 1e20);

    const old = runtime.inbox.add({
      taskId: task.id,
      terminal: false,
      reason: "observation",
      data,
    });

    for (let n = 0; n < 64; n++) {
      const newer = runtime.inbox.add({
        taskId: task.id,
        terminal: false,
        reason: "observation",
        data: n,
      });

      await host.runTool("task_inspect", { id: task.id, view: "event", eventId: newer.id }, ctx);
    }

    expect(runtime.inbox.count).toBe(1);

    const schema = Type.Object({
      payload: Type.Object({
        text: Type.String(),
        nextOffset: Type.Union([Type.Number(), Type.Null()]),
      }),
    });

    let offset: number | null = 0;
    let text = "";
    let pages = 0;

    while (offset !== null) {
      const response = await host.runTool(
        "task_inspect",
        { id: task.id, view: "event", eventId: old.id, offset },
        ctx,
      );

      const { payload } = Value.Parse(schema, response.details);

      if (payload.nextOffset !== null) expect(payload.nextOffset).toBeGreaterThan(offset);
      text += payload.text;
      offset = payload.nextOffset;
      pages++;
    }

    expect(pages).toBeGreaterThan(1);
    expect(JSON.parse(text)).toEqual(data);
    expect(runtime.inbox.evicted).toBe(0);
    expect(runtime.inbox.count).toBe(0);
    expect(runtime.inbox.lookup(task.id)).toHaveLength(65);
  });

  it("consumes only the selected event, and failed retrieval consumes nothing", async () => {
    const { host, runtime, task, ctx } = await completed();
    const [first, second, terminal] = runtime.inbox.lookup(task.id);
    assert.ok(first && second && terminal);

    for (const { args, error } of [
      { args: { id: task.id, view: "event", eventId: "missing" }, error: /Event not found/ },
      {
        args: { id: task.id, view: "event", eventId: first.id, offset: 50000 },
        error: /Invalid payload offset/,
      },
      { args: { id: task.id, view: "result", offset: 50000 }, error: /Invalid payload offset/ },
      { args: { id: task.id, view: "summary", offset: 1 }, error: /offset requires/ },
    ]) {
      await expect(host.runTool("task_inspect", args, ctx)).rejects.toThrow(error);
      expect(runtime.inbox.count).toBe(3);
    }

    await host.runTool("task_inspect", { id: task.id, view: "event", eventId: second.id }, ctx);
    expect(runtime.inbox.count).toBe(2);
    expect(runtime.inbox.take()?.events).toEqual([first, terminal]);
    expect(runtime.inbox.lookup(task.id)).toEqual([first, second, terminal]);
    expect(runtime.inbox.protected(task.id)).toBe(true);
  });

  it.each(["result", "stop", "terminal event"] as const)(
    "retrieving %s consumes terminal but not earlier watcher events",
    async (operation) => {
      const { host, runtime, task, ctx } = await completed();
      const events = runtime.inbox.lookup(task.id);

      if (operation === "result")
        await host.runTool("task_inspect", { id: task.id, view: "result" }, ctx);
      else if (operation === "stop") await host.runTool("task_stop", { id: task.id }, ctx);
      else {
        const terminal = events.find((event) => event.terminal);
        assert.ok(terminal);
        await host.runTool(
          "task_inspect",
          { id: task.id, view: "event", eventId: terminal.id },
          ctx,
        );
      }

      expect(runtime.inbox.count).toBe(2);
      expect(runtime.inbox.take()?.events).toEqual(events.filter((event) => !event.terminal));
      expect(runtime.inbox.protected(task.id)).toBe(true);
      expect(runtime.inbox.lookup(task.id)).toEqual(events);
    },
  );

  it("a running summary cannot consume its future completion", async () => {
    const { host, runtime, task, ctx } = await setup("setInterval(()=>{},1000)");
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, ctx);
    expect(response.details).toMatchObject({ task: { status: "running" }, events: [] });
    // Stop through the shared runtime, not the consuming agent tool.
    await runtime.stop(task.id);
    expect(runtime.inbox.count).toBe(1);
    expect(runtime.inbox.take()?.events).toMatchObject([
      { taskId: task.id, terminal: true, reason: "cancelled" },
    ]);
  });
});
