import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "../../../../tests/harness/agent-session.js";
import extension from "../index.js";
import { WAKE_TYPE } from "../delivery.js";
import { TaskLogs } from "../logs.js";

const harnesses: AgentSessionHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.session.abort();
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    h.cleanup();
  }
});

async function setup(extra: ExtensionFactory[] = [], mode: "tui" | "rpc" = "tui") {
  const h = await createAgentSessionHarness({
    extensionFactories: [extension, ...extra],
    mode,
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
      ...(protocol === undefined ? {} : { protocol }),
    }),
    { stopReason: "toolUse" },
  );

const wakes = (h: AgentSessionHarness) =>
  h.messages().flatMap((m) => (m.role === "custom" && m.customType === WAKE_TYPE ? [m] : []));

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

const stopped = (pid: number | undefined) => {
  if (!pid) throw new Error("Missing process ID");
  expect(() => process.kill(pid, 0)).toThrow();
};

async function callTool(
  h: AgentSessionHarness,
  name: string,
  args: { [key: string]: JsonValue | undefined },
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Tool JSON is untrusted; each caller validates its expected response schema.
): Promise<unknown> {
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
  it("discovers retained observations without knowing their IDs", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "for(let n=1;n<=10;n++) console.log(JSON.stringify({v:1,type:'event',data:n}));" +
          "console.log(JSON.stringify({v:1,type:'result',data:'done'}))",
        "events-v1",
      ),
      async () => {
        await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
        const [task] = tasks(h);
        assert.ok(task);
        expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 11 });

        return fauxAssistantMessage(
          fauxToolCall("task_inspect", { id: task.id, view: "summary" }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("Captured"),
      fauxAssistantMessage("Unexpected notification"),
    ]);
    await h.prompt("Capture observations");
    await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
    const [task] = tasks(h);
    assert.ok(task);
    const { id } = task;

    const response = h
      .messages()
      .findLast((m) => m.role === "toolResult" && m.toolName === "task_inspect");

    assert.ok(response?.role === "toolResult");
    const text = response.content.find((c) => c.type === "text");
    assert.ok(text);

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
      JSON.parse(text.text),
    );

    expect(summary.events.map((e) => e.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));

    const [firstEvent] = summary.events;
    assert.ok(firstEvent);

    const oldest = Value.Parse(
      payloadSchema,
      await callTool(h, "task_inspect", {
        id,
        view: "event",
        eventId: firstEvent.id,
      }),
    );

    expect(JSON.parse(oldest.payload.text)).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({
      omittedProgress: 0,
      evictedEvents: 0,
    });
    await delay(1100);
    expect(wakes(h)).toHaveLength(0);
    expect(h.getPendingResponseCount()).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
  });
  it("reads full payload pages after automatic notification", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "process.stderr.write(Buffer.alloc(24000,255));" +
          "const data='['+Array(2500).fill('1e20').join(',')+']';" +
          "for(const type of ['event','result']) process.stdout.write('{\"v\":1,\"type\":\"'+type+'\",\"data\":'+data+'}\\n')",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("Result received"),
    ]);
    await h.prompt("Capture observations");
    await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    const [task] = tasks(h);
    assert.ok(task);
    const { id } = task;

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
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
    expect(await callTool(h, "task_inspect", { id, view: "result" })).toMatchObject({
      payload: { offset: 0 },
    });
    expect(
      await callTool(h, "task_inspect", {
        id,
        view: "event",
        eventId,
        offset: eventPage.payload.nextOffset,
      }),
    ).toMatchObject({ payload: { offset: eventPage.payload.nextOffset } });
  });
  it.each(["tui", "rpc"] as const)(
    "%s automatically wakes idle with metadata only, then allows payload/log inspection",
    async (mode) => {
      const h = await setup([], mode);
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
      const task = tasks(h)[0];
      assert.ok(task);
      h.setResponses([
        fauxAssistantMessage(fauxToolCall("task_inspect", { id: task.id, view: "summary" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Inspected"),
      ]);
      await h.prompt("Inspect it", { source: "extension" });

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
      expect(
        JSON.stringify(
          h.messages().findLast((m) => m.role === "toolResult" && m.toolName === "task_inspect"),
        ),
      ).toContain("untrusted-payload");
    },
  );
  it.each([
    { stopReason: "stop", observations: 0, expectedAtSettle: 1 },
    { stopReason: "stop", observations: 10, expectedAtSettle: 1 },
    { stopReason: "error", observations: 0, expectedAtSettle: 0 },
    { stopReason: "aborted", observations: 0, expectedAtSettle: 0 },
  ] as const)(
    "admits ready notifications at a $stopReason boundary (observations=$observations)",
    async ({ stopReason, observations, expectedAtSettle }) => {
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const settledWakeCounts: number[] = [];
      let calls = 0;
      let pendingAtDelivery: unknown;

      const h = await setup([
        (pi) => {
          pi.on("before_provider_request", async () => {
            if (++calls === 2) {
              blocked.resolve();
              await release.promise;
            }

            if (calls === 3) pendingAtDelivery = await callTool(h, "task_list", {});
          });
          pi.on("agent_settled", () => {
            settledWakeCounts.push(wakes(h).length);
          });
        },
      ]);

      h.setResponses([
        start(
          `for(let n=0;n<${observations};n++) console.log(JSON.stringify({v:1,type:'event',data:n}));` +
            "console.log(JSON.stringify({v:1,type:'result',data:'done'}))",
          "events-v1",
        ),
        fauxAssistantMessage("Done other work", { stopReason }),
        fauxAssistantMessage("First batch"),
        ...(observations ? [fauxAssistantMessage("Remaining batch")] : []),
      ]);
      const prompt = h.prompt("Run a task and continue");

      try {
        await blocked.promise;
        await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
        await delay(150); // Observe at least one delivery debounce while still busy.
        expect(wakes(h)).toHaveLength(0);
      } finally {
        release.resolve();
      }

      await prompt;
      // The successful boundary consumes only one batch in the original activity.
      // Errors and aborts settle without a notification continuation.
      expect(settledWakeCounts).toEqual([expectedAtSettle]);
      const totalBatches = observations ? 2 : 1;
      await expect.poll(() => wakes(h).length).toBe(totalBatches);
      await expect.poll(() => h.session.isStreaming).toBe(false);
      expect(settledWakeCounts).toHaveLength(observations || !expectedAtSettle ? 2 : 1);
      expect(h.getPendingResponseCount()).toBe(0);
      expect(pendingAtDelivery).toMatchObject({ pending: Math.max(0, observations + 1 - 8) });
      expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });

      const notices = wakes(h).map((message) =>
        Value.Parse(
          Type.Object({ notices: Type.Array(Type.Object({ eventId: Type.String() })) }),
          message.details,
        ),
      );

      const ids = notices.flatMap((batch) => batch.notices.map((notice) => notice.eventId));
      expect(new Set(ids).size).toBe(observations + 1);
      expect(ids).toHaveLength(observations + 1);
      expect(notices[0]?.notices).toHaveLength(Math.min(observations + 1, 8));
    },
  );
  it.each(["rpc", "tui"] as const)(
    "records a boundary notice once when %s aborts after admission, without forcing a response",
    async (mode) => {
      const admitted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let proposed = false;
      let wakeMessageEnds = 0;

      const h = await setup(
        [
          (pi) => {
            pi.on("agent_before_settle", async (event) => {
              if (proposed) return;
              proposed = event.entries.some(
                (e) => e.type === "custom_message" && e.customType === WAKE_TYPE,
              );
              admitted.resolve();
              await release.promise;
            });
            pi.on("message_end", ({ message }) => {
              if (message.role === "custom" && message.customType === WAKE_TYPE) wakeMessageEnds++;
            });
          },
        ],
        mode,
      );

      h.setResponses([
        start("process.exit(0)"),
        async () => {
          await expect.poll(() => tasks(h).some((t) => t.status === "completed")).toBe(true);

          return fauxAssistantMessage("Done other work");
        },
        fauxAssistantMessage("Response to the next user request"),
      ]);
      const prompt = h.prompt("Start a task");

      try {
        await admitted.promise;
        expect(proposed).toBe(true);
        expect(wakes(h)).toHaveLength(0);
        expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 1 });
        expect(h.session.agent.peekQueuedMessages()).toHaveLength(0);

        // TUI clears queues before abort; RPC/public abort does not.
        if (mode === "tui") h.session.clearQueue();
        const aborting = h.session.abort();
        release.resolve();
        await aborting;
      } finally {
        release.resolve();
        await prompt;
      }

      expect(wakes(h)).toHaveLength(1);
      expect(wakeMessageEnds).toBe(0); // Boundary commits have no extension message_end receipt.
      expect(h.session.agent.peekQueuedMessages()).toHaveLength(0);
      expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
      const recorded = wakes(h)[0];
      assert.ok(recorded);
      await delay(1100); // Cross the old retry deadline; no duplicate or automatic model request.
      expect(wakes(h)).toEqual([recorded]);
      expect(h.getPendingResponseCount()).toBe(1);
      expect(h.eventsOfType("agent_settled")).toHaveLength(1);
      await h.prompt("Continue when I ask");
      expect(h.getPendingResponseCount()).toBe(0);
      expect(wakes(h)).toEqual([recorded]);
      expect(JSON.stringify(h.lastProviderPayload(Type.Unknown()))).toContain(recorded.content);
    },
  );
  it.each(["preserved", "dropped", "invalid"] as const)(
    "reconciles a %s boundary proposal against recorded history, not its preview",
    async (proposal) => {
      let firstBoundary = true;
      let proposedDetails: { batchId: string; notices: { eventId: string }[] } | undefined;
      let pendingAtProposal: unknown;

      const h = await createAgentSessionHarness({
        mode: "tui",
        extensionFactories: [
          (pi) => {
            pi.on("agent_before_settle", (event) => {
              if (!firstBoundary) return;
              firstBoundary = false;

              return {
                entries: [...event.entries, { type: "custom", customType: "test:prior-draft" }],
              };
            });
          },
          extension,
          (pi) => {
            pi.on("agent_before_settle", async (event) => {
              const wake = event.entries.find(
                (e) => e.type === "custom_message" && e.customType === WAKE_TYPE,
              );

              if (wake?.type !== "custom_message") return;
              proposedDetails = Value.Parse(
                Type.Object({
                  batchId: Type.String(),
                  notices: Type.Array(Type.Object({ eventId: Type.String() })),
                }),
                wake.details,
              );
              pendingAtProposal = await callTool(h, "task_list", {});

              if (proposal === "dropped")
                return { entries: event.entries.filter((e) => e !== wake), continue: false };

              if (proposal === "invalid")
                return {
                  entries: [
                    ...event.entries,
                    { type: "context_edit", targetId: "missing-entry", replacement: null },
                  ],
                };
            });
          },
        ],
      });

      harnesses.push(h);
      h.setResponses([
        start("process.exit(0)"),
        async () => {
          await expect.poll(() => tasks(h).some((t) => t.status === "completed")).toBe(true);

          return fauxAssistantMessage("Done other work");
        },
        fauxAssistantMessage("Notification received"),
      ]);
      await h.prompt("Start a task");
      assert.ok(proposedDetails);
      expect(pendingAtProposal).toMatchObject({ pending: 1 });
      expect(
        h.sessionManager
          .getBranch()
          .some((e) => e.type === "custom" && e.customType === "test:prior-draft"),
      ).toBe(proposal !== "invalid");
      expect(wakes(h)).toHaveLength(proposal === "preserved" ? 1 : 0);
      expect(await callTool(h, "task_list", {})).toMatchObject({
        pending: proposal === "preserved" ? 0 : 1,
      });
      await expect.poll(() => wakes(h).length, { timeout: 2000 }).toBe(1);
      await h.session.agent.waitForIdle();
      await expect.poll(() => h.session.isIdle).toBe(true);
      expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
      expect(h.getPendingResponseCount()).toBe(0);

      const recorded = Value.Parse(
        Type.Object({
          batchId: Type.String(),
          notices: Type.Array(Type.Object({ eventId: Type.String() })),
        }),
        wakes(h)[0]?.details,
      );

      expect(recorded.notices).toEqual(proposedDetails.notices);
      expect(recorded.batchId === proposedDetails.batchId).toBe(proposal === "preserved");
    },
  );
  it.each(["success", "failure", "abort"] as const)(
    "delivers a task notification after manual compaction ends with %s",
    async (outcome) => {
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const h = await createAgentSessionHarness({
        mode: "tui",
        settings: {
          compaction: { enabled: false, keepRecentTokens: 1 },
          retry: { enabled: false },
        },
        extensionFactories: [
          extension,
          (pi) => {
            pi.on("session_before_compact", async ({ preparation }) => {
              blocked.resolve();
              await release.promise;

              if (outcome === "failure") return;

              return {
                compaction: {
                  summary: "Synthetic compaction summary",
                  firstKeptEntryId: preparation.firstKeptEntryId,
                  tokensBefore: preparation.tokensBefore,
                },
              };
            });
          },
        ],
      });

      harnesses.push(h);
      const finish = join(h.tempDir, "finish-task");
      h.setResponses([
        start(
          `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);console.log('done');}},10)`,
        ),
        fauxAssistantMessage("Started the task; continue other work"),
      ]);
      await h.prompt("Start a task before compacting");
      h.setResponses([
        ...(outcome === "failure"
          ? [
              fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: "Synthetic compaction failure",
              }),
            ]
          : []),
        fauxAssistantMessage("Notification received"),
      ]);

      const compacting = h.session.compact().then(
        (result) => ({ result }),
        (cause: unknown) => ({ error: cause }),
      );

      try {
        await blocked.promise;
        await writeFile(finish, "done");
        await expect.poll(() => tasks(h).some((t) => t.status === "completed")).toBe(true);
        // Let the initial notification timer encounter the busy session.
        await delay(150);
        expect(h.session.isIdle).toBe(false);
        expect(wakes(h)).toHaveLength(0);
        expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 1 });

        if (outcome === "abort") h.session.abortCompaction();
      } finally {
        release.resolve();
        await compacting;
      }

      if (outcome === "success") {
        expect(await compacting).toMatchObject({
          result: { summary: "Synthetic compaction summary" },
        });
      } else {
        expect(await compacting).toHaveProperty("error", expect.any(Error));
      }

      expect(h.session.isIdle).toBe(true);
      await expect.poll(() => wakes(h).length, { timeout: 2000 }).toBe(1);
      await expect.poll(() => h.session.isStreaming).toBe(false);
      expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
    },
  );
  it("continues automatic notifications after an aborted response", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "setTimeout(()=>console.log(JSON.stringify({v:1,type:'event',data:1})),100);setTimeout(()=>console.log(JSON.stringify({v:1,type:'result',data:2})),600)",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("", { stopReason: "aborted" }),
      fauxAssistantMessage("Result received"),
    ]);
    await h.prompt("Watch synthetic state");
    await expect.poll(() => wakes(h).length).toBe(2);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
  });
  it("lists and inspects a running task, then stops it through task_stop", async () => {
    const h = await setup();
    const notices: string[] = [];
    await h.session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...h.session.extensionRunner.createContext().ui,
        notify: (message) => {
          notices.push(message);
        },
      },
    });
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("Started")]);
    await h.prompt("Start server");
    const task = tasks(h)[0];
    assert.ok(task);

    for (const command of ["", `inspect ${task.id}`]) {
      await h.prompt(`/tasks ${command}`);
      expect(() => process.kill(task.pid!, 0)).not.toThrow();
    }

    expect(notices).toHaveLength(2);

    for (const notice of notices) {
      expect(notice).toContain(task.id);
      expect(notice).toContain("running");
    }

    h.setResponses([fauxAssistantMessage("Stopped notification")]);
    expect(await callTool(h, "task_stop", { id: task.id })).toMatchObject({
      status: "cancelled",
      cleanup: "clean",
    });
    stopped(task.pid);
    await delay(1100);
    expect(wakes(h)).toHaveLength(0);
    expect(h.getPendingResponseCount()).toBe(1);
    expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
  });
  it("retains ancestral tasks, stops abandoned tasks, and does not resurrect them", async () => {
    const h = await setup();
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("A started")]);
    await h.prompt("Start A");
    const a = tasks(h)[0];
    assert.ok(a);
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
  it.each(["summary", "result"] as const)(
    "consumes a %s retrieved before cleanup emits the terminal notice",
    async (view) => {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // oxlint-disable-next-line typescript/unbound-method -- Preserve the native close for call(this) below; the cleanup gate never invokes it unbound.
      const close = TaskLogs.prototype.close;

      const held = vi.spyOn(TaskLogs.prototype, "close").mockImplementation(async function (
        this: TaskLogs,
      ) {
        reached.resolve();
        await release.promise;
        await close.call(this);
      });

      const h = await setup();
      const notices: string[] = [];
      await h.session.bindExtensions({
        mode: "tui",
        uiContext: {
          ...h.session.extensionRunner.createContext().ui,
          notify: (message) => {
            notices.push(message);
          },
        },
      });
      h.setResponses([
        start("console.log(JSON.stringify({v:1,type:'result',data:'done'}))", "events-v1"),
        async () => {
          await reached.promise;
          const [task] = tasks(h);
          assert.ok(task);
          // Process cleanup has reached log closure, but its terminal hook is still held.
          expect(await callTool(h, "task_list", {})).toMatchObject({
            tasks: [expect.objectContaining({ status: "result" })],
            pending: 0,
          });
          expect(tasks(h).some((t) => t.status === "result")).toBe(false);

          return fauxAssistantMessage(fauxToolCall("task_inspect", { id: task.id, view }), {
            stopReason: "toolUse",
          });
        },
        fauxAssistantMessage("Final answer"),
        fauxAssistantMessage("Unexpected stale notification"),
      ]);

      try {
        await h.prompt("Retrieve the result before terminal capture");

        const response = h
          .messages()
          .findLast((m) => m.role === "toolResult" && m.toolName === "task_inspect");

        assert.ok(response?.role === "toolResult");
        expect(response.isError).toBe(false);
        const text = response.content.find((c) => c.type === "text");
        assert.ok(text);
        expect(JSON.parse(text.text)).toMatchObject(
          view === "summary"
            ? { task: { status: "result" }, events: [] }
            : { payload: { text: JSON.stringify("done") } },
        );
        expect(wakes(h)).toHaveLength(0);
      } finally {
        release.resolve();
        held.mockRestore();
      }

      // Observe real capture without another consuming read or stop to hide the race.
      await expect.poll(() => tasks(h).some((t) => t.status === "result")).toBe(true);
      const [task] = tasks(h);
      assert.ok(task);
      await h.prompt(`/tasks inspect ${task.id}`);
      const [notice] = notices;
      assert.ok(notice);
      expect(JSON.parse(notice)).toMatchObject({
        events: [expect.objectContaining({ reason: "result" })],
      });
      await delay(1100);
      expect(wakes(h)).toHaveLength(0);
      expect(h.getPendingResponseCount()).toBe(1);
      expect(await callTool(h, "task_list", {})).toMatchObject({ pending: 0 });
    },
  );
  it("agent stop waits for cleanup without overwriting a decided result", async () => {
    const h = await setup();
    h.setResponses([
      start(
        "process.on('SIGTERM',()=>{});setTimeout(()=>console.log(JSON.stringify({v:1,type:'result',data:1})),100);setInterval(()=>{},1000)",
        "events-v1",
      ),
      fauxAssistantMessage("Started"),
    ]);
    await h.prompt("Start a TERM-resistant watcher");
    const [task] = tasks(h);
    assert.ok(task);
    const { id } = task;

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
      fauxAssistantMessage(fauxToolCall("task_stop", { id }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Stopped"),
    ]);
    await h.prompt("Stop the watcher");
    await expect.poll(async () => (await inspect()).task.cleanup).toBe("clean");
    expect((await inspect()).diagnostic).toBeUndefined();
    expect(tasks(h).some((t) => t.status === "result")).toBe(true);
  });
  it("filters an already-queued stale notice before provider context after tree navigation", async () => {
    const h = await setup();
    h.setResponses([
      start("setTimeout(()=>console.log('done'),100)"),
      fauxAssistantMessage("Started"),
      fauxAssistantMessage("Noticed"),
    ]);
    await h.prompt("Start on the old branch");
    await expect.poll(() => wakes(h).length).toBe(1);
    await expect.poll(() => h.session.isStreaming).toBe(false);
    const notice = wakes(h)[0];

    if (notice?.role !== "custom") throw new Error("Expected custom message");
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
    const [task] = tasks(h);
    assert.ok(task);
    expect(JSON.stringify(payload)).not.toContain(task.id);
  });
  it("reload stops owned processes and rebuilds empty live state", async () => {
    const h = await setup();
    h.setResponses([start("setInterval(()=>{},1000)"), fauxAssistantMessage("Started")]);
    await h.prompt("Start server");
    const task = tasks(h)[0];
    assert.ok(task);
    // Bound hosts receive session_start on reload, as the interactive application does.
    await h.session.bindExtensions({ uiContext: h.session.extensionRunner.createContext().ui });
    await h.session.reload();
    stopped(task.pid);
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
          pending: Type.Number(),
        }),
        JSON.parse(text.text),
      ),
    ).toMatchObject({ tasks: [], pending: 0 });
  });
});
