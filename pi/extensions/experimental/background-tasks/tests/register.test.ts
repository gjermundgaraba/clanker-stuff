import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { TaskRuntime } from "../runtime.js";
import { registerTaskTools } from "../register.js";
import { unread } from "../supervisor.js";
import { taskSummarySchema, listOutputSchema, inspectOutputSchema } from "../output.js";
import { LOG_BYTES } from "../logs.js";
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
  expect(unread(s.task)).toEqual({ events: 2, outcome: "result" });

  return s;
}

it("publishes schema-matching structured values for every tool", async () => {
  const { host, task, ctx } = await completed();

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
    taskSummarySchema,
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

  const list = Value.Parse(listOutputSchema, await call("task_list", {}));
  expect(list.tasks).toEqual([
    { id: task.id, name: "fixture", status: "result", cleanup: "clean", unread: true },
    { id: started.id, name: "running", status: "running", cleanup: "pending", unread: false },
  ]);
  expect(await call("task_inspect", { id: started.id })).toMatchObject({
    task: { id: started.id, status: "running" },
    logs: { stdout: "", stderr: "" },
    events: [],
  });
  expect(await call("task_stop", { id: started.id })).toMatchObject({
    id: started.id,
    status: "cancelled",
    cleanup: "clean",
  });
  const inspected = Value.Parse(inspectOutputSchema, await call("task_inspect", { id: task.id }));
  expect(inspected).not.toHaveProperty("diagnostic");
  expect(inspected).toMatchObject({
    task: { id: task.id, status: "result" },
    result: "done",
    logs: { stderr: "" },
    events: [
      { seq: 1, data: 1 },
      { seq: 2, data: 2 },
    ],
    omittedEvents: 0,
  });
});

it("keeps a watcher's result and retained events whole in direct text, cutting only log tails", async () => {
  // Keys and data of U+2028 and U+202E render as 6-byte escapes: retention keeps the newest
  // few of these events, and the result reaches the rendered record limit.
  const { host, task, ctx } = await setup(
    "const key=(i)=>'\\u2028'.repeat(124)+String(i).padStart(4,'0');" +
      "for(let i=0;i<20;i++)console.log(JSON.stringify({v:1,type:'event',key:key(i),data:'\\u202e'.repeat(600)}));" +
      "process.stderr.write('\"'.repeat(131072));" +
      "console.log(JSON.stringify({v:1,type:'result',data:'\\u202e'.repeat(2730)}))",
  );

  await expect.poll(() => task.outcome).toBe("result");
  await task.cleanupPromise;

  const inspected = await host.runTool(
    "task_inspect",
    { id: task.id, tailBytes: LOG_BYTES },
    { ctx },
  );

  const text = inspected.content.find((item) => item.type === "text");
  assert.ok(text?.type === "text");
  const details = Value.Parse(inspectOutputSchema, inspected.structuredContent);

  expect(text.text).toContain("Incomplete preview");
  expect(details.omittedEvents).toBeGreaterThan(0);
  expect(details.events.at(-1)?.key).toMatch(/0019$/u);
  // Everything ahead of the logs parses whole; toEqual skips the absent logs.
  expect(JSON.parse(`${text.text.slice(0, text.text.indexOf(',"logs":'))}}`)).toEqual({
    ...details,
    logs: undefined,
  });
});

it.each([null, false, 0, ""])(
  "returns captured falsy JSON data (%j), not absent data",
  async (data) => {
    const { host, task, ctx } = await setup(
      `for (const type of ['event','result']) console.log(JSON.stringify({v:1,type,data:${JSON.stringify(data)}}))`,
    );

    await expect.poll(() => task.outcome).toBe("result");
    const result = await host.runTool("task_inspect", { id: task.id }, { ctx });
    expect(result.structuredContent).toHaveProperty("result", data);
    expect(result.structuredContent).toHaveProperty("events", [{ seq: 1, data }]);
  },
);

it.each(["details", "structuredContent"] as const)(
  "isolates retained captures from mutations through %s",
  async (channel) => {
    const captured = { nested: { value: "original" }, items: ["original"] };

    const { host, task, ctx } = await setup(
      `for (const type of ['event','result']) console.log(JSON.stringify({v:1,type,data:${JSON.stringify(captured)}}))`,
    );

    await expect.poll(() => task.outcome).toBe("result");

    const schema = Type.Object({
      result: Type.Object({
        nested: Type.Object({ value: Type.String() }),
        items: Type.Array(Type.String()),
      }),
      events: Type.Array(Type.Object({ data: Type.Object({ items: Type.Array(Type.String()) }) })),
    });

    const response = await host.runTool("task_inspect", { id: task.id }, { ctx });
    const value = response[channel];
    // Check the actual returned reference: parsing/cloning here would conceal aliasing.
    assert.ok(Value.Check(schema, value));
    value.result.nested.value = "redacted";
    value.result.items.push("added by caller");
    value.events[0]?.data.items.push("added by caller");

    expect(task.result).toStrictEqual(captured);
    expect(task.notices.events[0]?.data).toStrictEqual(captured);
    const next = await host.runTool("task_inspect", { id: task.id }, { ctx });
    expect(next.structuredContent).toMatchObject({
      result: captured,
      events: [{ data: captured }],
    });
  },
);

it("renders an unsafe diagnostic as plain text in /tasks", async () => {
  const { host, task, ctx } = await completed();
  task.diagnostic = "failed \u001b[2J\u202eboom";
  await host.runCommand("tasks", task.id, ctx);
  const [message = ""] = host.getNotifications().map((notification) => notification.message);
  expect(message.split("\n")[1]).toBe("failed boom");
});

describe("notice clearing", () => {
  it("clears on a successful agent read, never on human, list or failed reads", async () => {
    const { host, task, ctx } = await completed();
    await host.runCommand("tasks", "", ctx);
    await host.runCommand("tasks", task.id, ctx);
    await host.runTool("task_list", {}, { ctx });
    await expect(host.runTool("task_inspect", { id: "missing" }, { ctx })).rejects.toThrow(
      /Unknown/,
    );
    expect(unread(task)).toEqual({ events: 2, outcome: "result" });
    await host.runTool("task_inspect", { id: task.id }, { ctx });
    expect(unread(task)).toBeUndefined();
    expect(host.getNotifications().map(({ message }) => message)).toEqual([
      `result · unread · fixture · ${task.id}`,
      `result · unread · fixture · ${task.id}\nstdout:\n` +
        '{"v":1,"type":"event","data":1}\n{"v":1,"type":"event","data":2}\n{"v":1,"type":"result","data":"done"}\n',
    ]);
  });

  it("clears on task_stop", async () => {
    const { host, task, ctx } = await completed();
    await host.runTool("task_stop", { id: task.id }, { ctx });
    expect(unread(task)).toBeUndefined();
  });

  it("a running read cannot clear its future outcome", async () => {
    const { host, runtime, task, ctx } = await setup(
      "console.log(JSON.stringify({v:1,type:'event',data:1}));setInterval(()=>{},1000)",
    );

    await expect.poll(() => unread(task)).toEqual({ events: 1 });
    await host.runTool("task_inspect", { id: task.id }, { ctx });
    expect(unread(task)).toBeUndefined();
    // Stop through the supervisor, not the clearing agent tool.
    await runtime.supervisor.stop(task.id);
    expect(unread(task)).toEqual({ events: 0, outcome: "cancelled" });
  });
});
