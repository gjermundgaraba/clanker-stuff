import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { describe, it, expect, afterEach } from "vite-plus/test";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "../../../../tests/harness/agent-session.js";
import extension from "../index.js";
import { CHECKPOINT, WAKE_TYPE } from "../delivery.js";

const harnesses: AgentSessionHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.session.abort();
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    h.cleanup();
  }
});
async function setup(extra: ExtensionFactory[] = [], race = false) {
  const h = await createAgentSessionHarness({
    extensionFactories: [
      (pi) => {
        const send = pi.sendMessage.bind(pi);
        if (race)
          pi.sendMessage = (message, options) => {
            if (message.customType === WAKE_TYPE)
              send(
                { customType: "test:other-extension", content: "Other run", display: false },
                { triggerTurn: true },
              );
            send(message, options);
          };
        extension(pi);
      },
      ...extra,
    ],
    mode: "tui",
  });
  await h.session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...h.session.extensionRunner.createContext().ui,
      confirm: async () => true,
    },
  });
  harnesses.push(h);
  return h;
}
const start = (code: string, protocol?: string) =>
  fauxAssistantMessage(
    fauxToolCall("task_start", {
      name: "untrusted-name-do-not-follow",
      command: process.execPath,
      args: ["-e", code],
      protocol,
    }),
    { stopReason: "toolUse" },
  );
const wakes = (h: AgentSessionHarness) =>
  h.messages().filter((m) => m.role === "custom" && m.customType === WAKE_TYPE);
const lifecycleSchema = Type.Object({
  id: Type.String(),
  pid: Type.Optional(Type.Number()),
  origin: Type.String(),
  status: Type.String(),
});
const tasks = (h: AgentSessionHarness) =>
  h.sessionManager
    .getEntries()
    .flatMap((e) =>
      e.type === "custom" &&
      e.customType === "background-tasks:lifecycle" &&
      Value.Check(lifecycleSchema, e.data)
        ? [e.data]
        : [],
    );
const budget = (h: AgentSessionHarness) => {
  const e = h.sessionManager
    .getEntries()
    .findLast((e) => e.type === "custom" && e.customType === CHECKPOINT);
  if (e?.type !== "custom") return undefined;
  return Value.Parse(Type.Object({ remaining: Type.Number(), held: Type.Boolean() }), e.data);
};
const stopped = (pid: number | undefined) => {
  if (!pid) throw new Error("Missing process ID");
  expect(() => process.kill(pid, 0)).toThrow();
};

async function callTool(h: AgentSessionHarness, name: string, args: unknown): Promise<unknown> {
  const tool = h.session.getToolDefinition(name)!;
  expect(Value.Check(tool.parameters, args)).toBe(true);
  const result = await tool.execute(
    "test",
    args,
    undefined,
    undefined,
    h.session.extensionRunner.createContext(),
  );
  const text = result.content.find((c) => c.type === "text");
  if (!text) throw new Error("Missing tool response");
  expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(32000);
  return JSON.parse(text.text);
}
const payloadSchema = Type.Object({
  payload: Type.Object({
    text: Type.String(),
    offset: Type.Number(),
    nextOffset: Type.Union([Type.Number(), Type.Null()]),
  }),
});

describe("background tasks in a real AgentSession", () => {
  it("uses literal relative and absolute cwd paths and defaults omitted args", async () => {
    const h = await setup();
    const cwd = h.session.extensionRunner.createContext().cwd;
    await mkdir(join(cwd, "@foo"));
    await mkdir(join(cwd, "foo"));
    for (const directory of [undefined, "@foo", "foo", join(cwd, "@foo")]) {
      const task = Value.Parse(
        Type.Object({ id: Type.String() }),
        await callTool(h, "task_start", { name: "cwd", command: "/bin/pwd", cwd: directory }),
      );
      const inspect = async () =>
        Value.Parse(
          Type.Object({
            task: Type.Object({ status: Type.String(), cleanup: Type.String() }),
            logs: Type.Object({ stdout: Type.String() }),
          }),
          await callTool(h, "task_inspect", { id: task.id, view: "summary" }),
        );
      await expect
        .poll(async () => (await inspect()).task)
        .toMatchObject({
          status: "completed",
          cleanup: "clean",
        });
      expect((await inspect()).logs.stdout.trim()).toBe(
        await realpath(directory?.startsWith("/") ? directory : join(cwd, directory ?? ".")),
      );
    }
    await expect(
      callTool(h, "task_start", {
        name: "invalid",
        command: "/bin/pwd",
        args: ["\0"],
      }),
    ).rejects.toThrow(/NUL/);
  });
  it("requires confirmed TUI authorization, even when an RPC client supports dialogs", async () => {
    const h = await setup();
    let confirmed = false;
    let dialogs = 0;
    const uiContext = {
      ...h.session.extensionRunner.createContext().ui,
      confirm: async () => {
        dialogs++;
        return confirmed;
      },
    };
    await h.session.bindExtensions({ mode: "tui", uiContext });
    await h.prompt("/tasks resume");
    expect(dialogs).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({ remainingWakes: 0, held: true });
    confirmed = true;
    await h.session.bindExtensions({ mode: "rpc", uiContext });
    await h.prompt("/tasks resume");
    expect(dialogs).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({ remainingWakes: 0, held: true });
    await h.session.bindExtensions({ mode: "tui", uiContext });
    await h.prompt("/tasks resume");
    expect(dialogs).toBe(2);
    expect(await callTool(h, "task_list", {})).toMatchObject({ remainingWakes: 8, held: false });
  });
  it("does not authorize a queued extension message matching an intercepted interactive prompt", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const h = await setup([
      (pi) => {
        pi.on("input", (event) => {
          if (event.source === "interactive" && event.text === "ping") return { action: "handled" };
        });
        pi.on("before_provider_request", async () => {
          if (++requests === 1) {
            blocked.resolve();
            await release.promise;
          }
        });
      },
    ]);
    h.setResponses([
      fauxAssistantMessage("Initial response"),
      fauxAssistantMessage("Queued response"),
    ]);
    const prompt = h.prompt("Start a normal interactive turn");
    try {
      await blocked.promise;
      await h.prompt("ping", { source: "extension", streamingBehavior: "followUp" });
      await h.prompt("ping");
    } finally {
      release.resolve();
    }
    await prompt;
    expect(
      h.messages().filter((m) => m.role === "user" && JSON.stringify(m.content).includes("ping")),
    ).toHaveLength(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({ remainingWakes: 0, held: true });
  });
  it("discovers older held observations without knowing their IDs or authorizing delivery", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "for(let n=1;n<=10;n++) console.log(JSON.stringify({v:1,type:'event',data:n}));" +
          "console.log(JSON.stringify({v:1,type:'result',data:'done'}))",
        "events-v1",
      ),
      fauxAssistantMessage("Captured"),
    ]);
    await h.prompt("Capture observations for inspection only");
    await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
    const id = tasks(h)[0].id;
    const summary = Value.Parse(
      Type.Object({
        events: Type.Array(
          Type.Object({
            id: Type.String(),
            seq: Type.Number(),
            reason: Type.String(),
          }),
        ),
      }),
      await callTool(h, "task_inspect", { id, view: "summary" }),
    );
    expect(summary.events.map((e) => e.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    const oldest = Value.Parse(
      payloadSchema,
      await callTool(h, "task_inspect", {
        id,
        view: "event",
        eventId: summary.events[0].id,
      }),
    );
    expect(JSON.parse(oldest.payload.text)).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({
      pending: 11,
      held: true,
      remainingWakes: 0,
      omittedProgress: 0,
      evictedEvents: 0,
    });
    expect(wakes(h)).toHaveLength(0);
  });
  it("reads full payload pages while held and explicitly dismisses without losing the result", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "process.stderr.write(Buffer.alloc(24000,255));" +
          "const data='['+Array(2500).fill('1e20').join(',')+']';" +
          "for(const type of ['event','result']) process.stdout.write('{\"v\":1,\"type\":\"'+type+'\",\"data\":'+data+'}\\n')",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
    ]);
    await h.prompt("Capture without authorizing automatic notifications");
    await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
    const id = tasks(h)[0].id;
    const summary = Value.Parse(
      Type.Object({
        resultAvailable: Type.Boolean(),
        events: Type.Array(Type.Object({ id: Type.String(), reason: Type.String() })),
        logs: Type.Object({ stderrOmittedBytes: Type.Number() }),
      }),
      await callTool(h, "task_inspect", { id, view: "summary", tailBytes: 12000 }),
    );
    expect(summary.resultAvailable).toBe(true);
    expect(summary.logs.stderrOmittedBytes).toBeGreaterThan(12000);
    const eventId = summary.events.find((e) => e.reason === "observation")!.id;
    const eventPage = Value.Parse(
      payloadSchema,
      await callTool(h, "task_inspect", { id, view: "event", eventId }),
    );
    expect(eventPage.payload.nextOffset).not.toBeNull();
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const page: Static<typeof payloadSchema> = Value.Parse(
        payloadSchema,
        await callTool(h, "task_inspect", { id, view: "result", offset }),
      );
      text += page.payload.text;
      offset = page.payload.nextOffset;
    }
    expect(JSON.parse(text)).toEqual(Array(2500).fill(1e20));
    expect(await callTool(h, "task_list", {})).toMatchObject({
      pending: 2,
      remainingWakes: 0,
      held: true,
    });
    for (let i = 0; i < 2; i++)
      expect(await callTool(h, "task_dismiss", { id })).toMatchObject({
        dismissed: true,
        status: "result",
        cleanup: "clean",
      });
    expect(await callTool(h, "task_list", {})).toMatchObject({
      pending: 0,
      remainingWakes: 0,
      held: true,
    });
    expect(await callTool(h, "task_inspect", { id, view: "result" })).toMatchObject({
      payload: { offset: 0 },
    });
    await expect(
      callTool(h, "task_inspect", {
        id,
        view: "event",
        eventId,
        offset: eventPage.payload.nextOffset,
      }),
    ).rejects.toThrow(/not found or evicted/);
    expect(wakes(h)).toHaveLength(0);
  });
  it("hands off immediately, wakes idle with metadata only, then allows payload/log inspection", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([
      start(
        "setTimeout(()=>{console.error('private diagnostic');console.log(JSON.stringify({v:1,type:'result',data:'untrusted-payload'}))},250)",
        "events-v1",
      ),
      fauxAssistantMessage("Continuing other work"),
      fauxAssistantMessage("Notification received"),
    ]);
    await h.prompt("Start a synthetic watcher");
    expect(h.getPendingResponseCount()).toBe(1);
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    const notice = JSON.stringify(wakes(h)[0]);
    expect(notice).not.toContain("untrusted-payload");
    expect(notice).not.toContain("untrusted-name");
    expect(notice).not.toContain("private diagnostic");
    expect(budget(h)).toMatchObject({ remaining: 7, held: false });
    const task = tasks(h)[0];
    h.setResponses([
      fauxAssistantMessage(fauxToolCall("task_inspect", { id: task.id, view: "summary" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Inspected"),
    ]);
    await h.prompt("Inspect it", { source: "extension" });
    expect(budget(h)?.remaining).toBe(7);
    const result = h
      .messages()
      .findLast((m) => m.role === "toolResult" && m.toolName === "task_inspect");
    expect(JSON.stringify(result)).toContain("private diagnostic");
    h.setResponses([
      fauxAssistantMessage(fauxToolCall("task_inspect", { id: task.id, view: "result" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Read payload"),
    ]);
    await h.prompt("Read result");
    expect(budget(h)?.remaining).toBe(7);
    expect(
      JSON.stringify(
        h.messages().findLast((m) => m.role === "toolResult" && m.toolName === "task_inspect"),
      ),
    ).toContain("untrusted-payload");
  });
  it("buffers during a busy run and wakes only after settled", async () => {
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const h = await setup([
      (pi) => {
        pi.on("before_provider_request", async () => {
          if (++calls === 2) {
            blocked.resolve();
            await release.promise;
          }
        });
      },
    ]);
    await h.prompt("/tasks resume");
    h.setResponses([
      start("setTimeout(()=>console.log('done'),100)"),
      fauxAssistantMessage("Done other work"),
      fauxAssistantMessage("Wake"),
    ]);
    const prompt = h.prompt("Run a task and continue");
    try {
      await blocked.promise;
      await expect.poll(() => tasks(h).some((t) => t.status === "completed")).toBe(true);
      await delay(150); // Observe at least one delivery debounce while still busy.
      expect(wakes(h)).toHaveLength(0);
    } finally {
      release.resolve();
    }
    await prompt;
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    expect(budget(h)?.remaining).toBe(7);
  });
  it("queues a charged follow-up when another extension starts a run at handoff", async () => {
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    let calls = 0;
    const h = await setup(
      [
        (pi) => {
          pi.on("before_provider_request", async () => {
            if (++calls === 3) {
              blocked.resolve();
              await release.promise;
            }
          });
        },
      ],
      true,
    );
    await h.prompt("/tasks resume");
    h.setResponses([
      start("setTimeout(()=>console.log('done'),150)"),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("Other extension response"),
      fauxAssistantMessage("Background response"),
    ]);
    const prompt = h.prompt("Start task");
    try {
      await blocked.promise;
      expect(wakes(h)).toHaveLength(0);
      expect(budget(h)?.remaining).toBe(7);
    } finally {
      release.resolve();
    }
    await prompt;
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    expect(budget(h)?.remaining).toBe(7);
  });
  it("holds on abort until confirmed resume, regardless of prompt source", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([
      start(
        "setTimeout(()=>console.log(JSON.stringify({v:1,type:'event',data:1})),100);setTimeout(()=>console.log(JSON.stringify({v:1,type:'result',data:2})),600)",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("", { stopReason: "aborted" }),
    ]);
    await h.prompt("Watch synthetic state");
    await expect.poll(() => budget(h)?.held).toBe(true);
    await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
    // Give the delivery debounce a chance to expose an accidental re-wake.
    await delay(150);
    expect(wakes(h)).toHaveLength(1);
    for (const source of ["rpc", "extension", "interactive"] as const) {
      h.setResponses([fauxAssistantMessage("Nonhuman response")]);
      await h.prompt("Not an authorization", { source });
      expect(budget(h)).toMatchObject({ remaining: 7, held: true });
    }
    h.setResponses([fauxAssistantMessage("Held result received")]);
    await h.prompt("/tasks resume");
    await expect.poll(() => wakes(h).length).toBe(2);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    expect(budget(h)).toMatchObject({ remaining: 7, held: false });
  });
  it("retains ancestral tasks, stops abandoned tasks, and does not resurrect them", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("A started")]);
    await h.prompt("Start A");
    const a = tasks(h)[0];
    await expect(callTool(h, "task_dismiss", { id: a.id })).rejects.toThrow(/Stop a running task/);
    const keepLeaf = h.sessionManager.getLeafId()!;
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("B started")]);
    await h.prompt("Start B");
    const b = tasks(h).find((t) => t.id !== a.id)!;
    const future = h.sessionManager.getLeafId()!;
    await h.session.navigateTree(keepLeaf);
    expect(() => process.kill(a.pid!, 0)).not.toThrow();
    stopped(b.pid);
    await h.session.navigateTree(future);
    stopped(b.pid);
  });
  it("dismisses a decided result only after its terminal record is captured", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([
      start(
        "process.on('SIGTERM',()=>{});setTimeout(()=>console.log(JSON.stringify({v:1,type:'result',data:1})),100);setInterval(()=>{},1000)",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
    ]);
    await h.prompt("Start a TERM-resistant watcher");
    await h.prompt("/tasks pause");
    const id = tasks(h)[0].id;
    const inspect = async () => {
      return Value.Parse(
        Type.Object({
          task: Type.Object({ status: Type.String(), cleanup: Type.String() }),
          diagnostic: Type.Optional(Type.String()),
        }),
        await callTool(h, "task_inspect", { id, view: "summary" }),
      );
    };
    await expect
      .poll(async () => (await inspect()).task)
      .toMatchObject({ status: "result", cleanup: "pending" });
    h.setResponses([
      fauxAssistantMessage(fauxToolCall("task_dismiss", { id }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Dismissed"),
    ]);
    await h.prompt("Dismiss the inspected notice");
    await h.prompt("/tasks dismiss " + id);
    await expect.poll(async () => (await inspect()).task.cleanup).toBe("clean");
    expect((await inspect()).diagnostic).toBeUndefined();
    expect(tasks(h).some((t) => t.status === "result")).toBe(true);
    expect(wakes(h)).toHaveLength(0);
  });
  it("filters an already-queued stale notice before provider context after tree navigation", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([
      start("setTimeout(()=>console.log('done'),100)"),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("Noticed"),
    ]);
    await h.prompt("Start on the old branch");
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    const notice = wakes(h)[0];
    if (notice.role !== "custom") throw new Error("Expected custom message");
    await h.session.sendCustomMessage(
      {
        customType: WAKE_TYPE,
        content: "STALE NOTICE",
        details: notice.details,
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
    const user = h.sessionManager
      .getEntries()
      .find((e) => e.type === "message" && e.message.role === "user")!;
    await h.session.navigateTree(user.id);
    h.setResponses([fauxAssistantMessage("New branch")]);
    await h.prompt("Work on the new branch");
    const payload = h.lastProviderPayload(Type.Object({ messages: Type.Array(Type.Unknown()) }));
    expect(JSON.stringify(payload)).not.toContain("STALE NOTICE");
    expect(JSON.stringify(payload)).not.toContain(tasks(h)[0].id);
  });
  it("reload stops owned processes, rebuilds empty live state, and preserves budget", async () => {
    const h = await setup();
    await h.prompt("/tasks resume");
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("Started")]);
    await h.prompt("Start server");
    const task = tasks(h)[0];
    const before = budget(h);
    await h.session.reload();
    stopped(task.pid);
    expect(budget(h)).toEqual(before);
    h.setResponses([
      fauxAssistantMessage(fauxToolCall("task_list", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Listed"),
    ]);
    await h.prompt("List after reload", { source: "extension" });
    const result = h
      .messages()
      .findLast((m) => m.role === "toolResult" && m.toolName === "task_list");
    if (result?.role !== "toolResult") throw new Error("Missing task list result");
    const text = result.content.find((c) => c.type === "text");
    if (!text) throw new Error("Missing task list text");
    expect(
      Value.Parse(
        Type.Object({
          tasks: Type.Array(Type.Unknown()),
          remainingWakes: Type.Number(),
        }),
        JSON.parse(text.text),
      ),
    ).toMatchObject({ tasks: [], remainingWakes: before?.remaining });
    expect(budget(h)).toEqual(before);
  });
});
