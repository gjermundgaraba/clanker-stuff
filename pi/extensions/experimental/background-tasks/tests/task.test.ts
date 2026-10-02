import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { describe, it, expect } from "vite-plus/test";
import { Value } from "typebox/value";
import { inspectOutputSchema } from "../output.js";
import {
  startSchema,
  inspectSchema,
  idSchema,
  listSchema,
  toolResult,
  taskRow,
  MAX_TEXT_BYTES,
} from "../task.js";

describe("task contracts", () => {
  it("keeps schemas closed and bounded, without retired pagination arguments", () => {
    const start = { name: "test", command: "node" };
    expect(Value.Check(startSchema, start)).toBe(true);
    expect(Value.Check(startSchema, { ...start, args: [] })).toBe(true);

    for (const extra of [
      { args: null },
      { args: Array(129).fill("") },
      { args: ["x".repeat(32769)] },
      { detach: true },
      { protocol: "events" },
      { timeoutMs: 86400001 },
      { timeoutMs: 0 },
    ])
      expect(Value.Check(startSchema, { ...start, ...extra })).toBe(false);
    expect(Value.Check(inspectSchema, { id: "a" })).toBe(false);

    for (const invalid of [
      null,
      [],
      { id: "a", view: null },
      { id: "a", view: "summary", offset: 0 },
      { id: "a", view: "event", eventId: "e", offset: 0 },
      { id: "a", view: "result", offset: 0 },
      { id: "a", view: "summary", other: 1 },
      { id: "a", view: "summary", tailBytes: 12001 },
    ])
      expect(Value.Check(inspectSchema, invalid)).toBe(false);
    expect(Value.Check(idSchema, { id: "a", other: 1 })).toBe(false);
    expect(Value.Check(listSchema, { other: 1 })).toBe(false);
  });
  it.each([null, false, 0, "", Array(1000).fill(0), { controls: "\x1b[31m\u009b\u202e" }])(
    "keeps small values complete and semantically identical in all output channels (%j)",
    (data) => {
      const details = { taskId: "t", view: "result" as const, untrusted: true as const, data };
      const result = toolResult(details);
      expect(Value.Check(inspectOutputSchema, result.structuredContent)).toBe(true);
      expect(result.details).toStrictEqual(details);
      expect(result.structuredContent).toStrictEqual(details);
      expect(JSON.parse(result.content[0].text)).toStrictEqual(details);

      for (const control of ["\x1b", "\u009b", "\u202e"])
        expect(result.content[0].text).not.toContain(control);
    },
  );
  it.each([
    { data: Array.from({ length: 2500 }, () => 1e20) },
    {
      data: [
        ...Array.from({ length: 400 }, () => 1e20),
        "😀".repeat(2000),
        ...Array.from({ length: 1000 }, () => 1e20),
      ],
    },
    { data: "\u202e".repeat(6500) + "😀" },
  ])("returns large values intact but bounds and labels text previews", ({ data }) => {
    const result = toolResult({ taskId: "t_test", view: "result", untrusted: true, data });
    const text = result.content[0].text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(text).toContain("Incomplete text preview");
    expect(text).toContain("not complete JSON");
    expect(text).toContain("Code Mode");
    expect(text).not.toContain("\ufffd");
    expect(text).not.toContain("\u202e");
    expect(JSON.parse(text.split("\n")[0]!)).toEqual({
      taskId: "t_test",
      view: "result",
      untrusted: true,
    });
    expect(result.structuredContent).toStrictEqual({
      taskId: "t_test",
      view: "result",
      untrusted: true,
      data,
    });
    expect(result.details).toStrictEqual(result.structuredContent);
    expect(Value.Check(inspectOutputSchema, result.structuredContent)).toBe(true);
    expect(Buffer.byteLength(jsonText(result.structuredContent))).toBeGreaterThan(MAX_TEXT_BYTES);
  });
  it("preserves full log tails and summary diagnostics when text needs a preview", () => {
    const task = {
      id: "t_test",
      name: "failed",
      status: "process_error" as const,
      cleanup: "failed" as const,
      startedAt: 1000,
      endedAt: 2500,
      abandoned: false,
    };

    const logs = {
      stdout: "\ufffd".repeat(12000),
      stderr: "\ufffd".repeat(12000),
      stdoutOmittedBytes: 10,
      stderrOmittedBytes: 20,
      directory: "/tmp/logs",
      storageError: "disk full",
    };

    const result = toolResult({
      task,
      diagnostic: "process failed",
      resultAvailable: false,
      events: [{ id: "e_test", seq: 1, reason: "process_error" }],
      logs,
      trust: "untrusted output",
    });

    const text = result.content[0].text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(text).toContain("Incomplete text preview");
    expect(JSON.parse(text.split("\n")[0]!)).toEqual({
      task,
      diagnostic: "process failed",
      resultAvailable: false,
      storageError: "disk full",
      trust: "untrusted output",
    });
    expect(result.structuredContent.logs).toStrictEqual(logs);
    expect(result.structuredContent.events).toEqual([
      { id: "e_test", seq: 1, reason: "process_error" },
    ]);
    expect(Value.Check(inspectOutputSchema, result.structuredContent)).toBe(true);
  });
  it("fits the retained inventory and pending count, bounding only display names", () => {
    const tasks = Array.from({ length: 72 }, (_, i) =>
      taskRow({
        id: "t_" + String(i).padStart(36, "0"),
        name: "😀".repeat(80),
        pid: 12345,
        status: "protocol_error",
        cleanup: "failed",
        startedAt: Date.now(),
        endedAt: Date.now(),
        exitCode: 137,
        signal: "SIGKILL",
        abandoned: false,
      }),
    );

    const result = toolResult({
      pending: 32,
      tasks,
      omittedProgress: 100,
      evictedEvents: 100,
      evictedTasks: 100,
      lifetime: "",
    });

    const parsed: unknown = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ pending: 32, tasks });
    expect(parsed).toHaveProperty("tasks.length", 72);
    expect(parsed).toHaveProperty("tasks.71.id", tasks.at(-1)?.id);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);

    for (const task of tasks) expect(Array.from(task.name)).toHaveLength(33);
  });
});
