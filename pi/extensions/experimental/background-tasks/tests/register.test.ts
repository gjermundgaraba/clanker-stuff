import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { TaskRuntime } from "../runtime.js";
import { registerTaskTools } from "../register.js";
import { startOutputSchema, listOutputSchema, inspectOutputSchema } from "../output.js";
import { MAX_TEXT_BYTES } from "../task.js";
import type { JsonObject } from "@earendil-works/pi-ai";

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
  const ctx = host.createToolContext({ mode: "tui", isIdle: () => false });
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

it("publishes schema-matching structured values for every tool and inspection view", async () => {
  const { host, runtime, task, ctx } = await completed();

  const call = async (name: string, args: JsonObject) => {
    const definition = host.getRegisteredTools().get(name)?.definition;
    assert.ok(definition?.outputSchema);
    const result = await host.runTool(name, args, { ctx });
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text?.type === "text");
    expect(Value.Check(definition.outputSchema, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toStrictEqual(JSON.parse(text.text));
    expect(result.structuredContent).toStrictEqual(result.details);
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);

    return result.structuredContent;
  };

  const started = Value.Parse(
    startOutputSchema,
    await call("task_start", {
      name: "running",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    }),
  );

  expect(started.status).toBe("running");
  expect(started.pid).toBeGreaterThan(0);
  expect(started).not.toHaveProperty("endedAt");
  expect(started).not.toHaveProperty("exitCode");
  expect(started).not.toHaveProperty("signal");

  const list = Value.Parse(listOutputSchema, await call("task_list", {}));
  expect(list.tasks).toContainEqual({
    id: started.id,
    name: "running",
    status: "running",
    cleanup: "pending",
    abandoned: false,
  });
  expect(await call("task_inspect", { id: started.id, view: "summary" })).toMatchObject({
    task: { id: started.id, status: "running" },
    resultAvailable: false,
    logs: { stdout: "", stderr: "" },
  });
  expect(await call("task_stop", { id: started.id })).toMatchObject({
    id: started.id,
    status: "cancelled",
    cleanup: "clean",
  });
  const terminal = runtime.inbox.lookup(started.id).find((event) => event.terminal);
  assert.ok(terminal);

  const lifecycle = await call("task_inspect", {
    id: started.id,
    view: "event",
    eventId: terminal.id,
  });

  expect(lifecycle).toMatchObject({ view: "event", untrusted: true, reason: "cancelled" });
  expect(lifecycle).not.toHaveProperty("data");

  const event = runtime.inbox.lookup(task.id).find((event) => !event.terminal);
  assert.ok(event);
  expect(
    await call("task_inspect", { id: task.id, view: "event", eventId: event.id }),
  ).toMatchObject({
    view: "event",
    data: 1,
  });
  expect(await call("task_inspect", { id: task.id, view: "result" })).toMatchObject({
    view: "result",
    data: "done",
  });
  expect(await call("task_inspect", { id: task.id, view: "summary" })).toMatchObject({
    task: { id: task.id, status: "result" },
    resultAvailable: true,
  });
});

it.each([null, false, 0, ""])(
  "returns captured falsy JSON data (%j), not absent data",
  async (data) => {
    const { host, task, ctx } = await setup(
      `for (const type of ['event','result']) console.log(JSON.stringify({v:1,type,data:${JSON.stringify(data)}}))`,
    );

    await expect.poll(() => task.outcome).toBe("result");
    await task.cleanupPromise;
    const summary = await host.runTool("task_inspect", { id: task.id, view: "summary" }, { ctx });
    const value = Value.Parse(inspectOutputSchema, summary.structuredContent);
    assert.ok("events" in value);
    const event = value.events.find(({ reason }) => reason === "observation");
    assert.ok(event);

    for (const args of [
      { id: task.id, view: "result" },
      { id: task.id, view: "event", eventId: event.id },
    ]) {
      const result = await host.runTool("task_inspect", args, { ctx });
      expect(result.structuredContent).toHaveProperty("data", data);
      expect(Value.Check(inspectOutputSchema, result.structuredContent)).toBe(true);
    }
  },
);

it.each(["details", "structuredContent"] as const)(
  "isolates retained captures from mutations through %s",
  async (channel) => {
    const captured = { nested: { value: "original" }, items: ["original"] };

    const { host, runtime, task, ctx } = await setup(
      `for (const type of ['event','result']) console.log(JSON.stringify({v:1,type,data:${JSON.stringify(captured)}}))`,
    );

    await expect.poll(() => task.outcome).toBe("result");
    await task.cleanupPromise;
    const events = runtime.inbox.lookup(task.id);
    const progress = events.find((event) => !event.terminal);
    const terminal = events.find((event) => event.terminal);
    assert.ok(progress && terminal);

    const inspections = [
      { id: task.id, view: "event", eventId: progress.id },
      { id: task.id, view: "result" },
      { id: task.id, view: "event", eventId: terminal.id },
    ];

    const schema = Type.Object({
      data: Type.Object({
        nested: Type.Object({ value: Type.String() }),
        items: Type.Array(Type.String()),
      }),
    });

    for (const args of inspections) {
      const previous = await host.runTool("task_inspect", args, { ctx });
      const response = await host.runTool("task_inspect", args, { ctx });
      const value = response[channel];
      // Check the actual returned reference: parsing/cloning here would conceal aliasing.
      assert.ok(Value.Check(schema, value));
      value.data.nested.value = "redacted";
      value.data.items.push("added by caller");

      expect(task.result).toStrictEqual(captured);
      expect(progress.data).toStrictEqual(captured);
      expect(terminal.data).toStrictEqual(captured);
      expect(previous.structuredContent).toMatchObject({ data: captured });
      expect(previous.details).toMatchObject({ data: captured });

      for (const reread of inspections) {
        const next = await host.runTool("task_inspect", reread, { ctx });
        expect(next.structuredContent).toMatchObject({ data: captured });
        expect(next.details).toMatchObject({ data: captured });
      }
    }
  },
);

describe("targeted task-tool consumption", () => {
  it("keeps human and shared reads pure, but consumes all IDs in an agent summary", async () => {
    const { host, runtime, task, ctx } = await completed();
    const events = runtime.inbox.lookup(task.id);
    runtime.inspect({ id: task.id, view: "summary" }, "observe");
    await host.runCommand("tasks", "", ctx);
    await host.runCommand("tasks", `inspect ${task.id}`, ctx);
    await host.runTool("task_list", {}, { ctx });
    expect(runtime.inbox.count).toBe(3);
    expect(runtime.inbox.protected(task.id)).toBe(true);
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, { ctx });
    expect(response.details).toMatchObject({ events: events.map(({ id }) => ({ id })) });
    expect(runtime.inbox.count).toBe(0);
    expect(runtime.inbox.protected(task.id)).toBe(false);
    expect(runtime.inbox.lookup(task.id)).toEqual(events);
    await host.runTool("task_inspect", { id: task.id, view: "summary" }, { ctx });
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
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, { ctx });
    expect(response.details).toMatchObject({ events: events.map(({ id }) => ({ id })) });
    expect(runtime.inbox.count).toBe(0);
    const [first] = events;
    assert.ok(first);

    const oldest = await host.runTool(
      "task_inspect",
      { id: task.id, view: "event", eventId: first.id },
      { ctx },
    );

    expect(oldest.details).toMatchObject({ data: 0 });
    expect(runtime.inbox.lookup(task.id)).toEqual(events);
    expect(runtime.inbox.evicted).toBe(0);
  });

  it("retrieves an older large event in one call with a full newer retired history", async () => {
    const { host, runtime, task, ctx } = await setup("setInterval(()=>{},1000)");
    // This fits a watcher record as 1e20 literals, but expands past the text budget.
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

      await host.runTool(
        "task_inspect",
        { id: task.id, view: "event", eventId: newer.id },
        { ctx },
      );
    }

    expect(runtime.inbox.count).toBe(1);

    const response = await host.runTool(
      "task_inspect",
      { id: task.id, view: "event", eventId: old.id },
      { ctx },
    );

    expect(Value.Check(inspectOutputSchema, response.structuredContent)).toBe(true);
    expect(response.structuredContent).toStrictEqual({
      taskId: task.id,
      view: "event",
      eventId: old.id,
      reason: "observation",
      untrusted: true,
      data,
    });
    expect(response.details).toStrictEqual(response.structuredContent);
    const text = response.content.find((item) => item.type === "text");
    assert.ok(text?.type === "text");
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(text.text).toContain("Incomplete text preview");
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
        args: { id: task.id, view: "event" },
        error: /requires eventId/,
      },
      { args: { id: task.id, view: "result", eventId: first.id }, error: /eventId requires/ },
    ]) {
      await expect(host.runTool("task_inspect", args, { ctx })).rejects.toThrow(error);
      expect(runtime.inbox.count).toBe(3);
    }

    await host.runTool("task_inspect", { id: task.id, view: "event", eventId: second.id }, { ctx });
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
        await host.runTool("task_inspect", { id: task.id, view: "result" }, { ctx });
      else if (operation === "stop") await host.runTool("task_stop", { id: task.id }, { ctx });
      else {
        const terminal = events.find((event) => event.terminal);
        assert.ok(terminal);
        await host.runTool(
          "task_inspect",
          { id: task.id, view: "event", eventId: terminal.id },
          { ctx },
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
    const response = await host.runTool("task_inspect", { id: task.id, view: "summary" }, { ctx });
    expect(response.details).toMatchObject({ task: { status: "running" }, events: [] });
    // Stop through the shared runtime, not the consuming agent tool.
    await runtime.stop(task.id);
    expect(runtime.inbox.count).toBe(1);
    expect(runtime.inbox.take()?.events).toMatchObject([
      { taskId: task.id, terminal: true, reason: "cancelled" },
    ]);
  });
});
