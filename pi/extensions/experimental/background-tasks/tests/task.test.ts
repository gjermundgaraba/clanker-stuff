import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { describe, it, expect } from "vite-plus/test";
import { Value } from "typebox/value";
import {
  startSchema,
  inspectSchema,
  idSchema,
  listSchema,
  toolResult,
  payloadPage,
  taskRow,
  MAX_TOOL_BYTES,
} from "../task.js";

describe("task contracts", () => {
  it("keeps schemas closed and bounded", () => {
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
      { id: "a", view: "summary", offset: -1 },
      { id: "a", view: "summary", other: 1 },
      { id: "a", view: "summary", tailBytes: 12001 },
    ])
      expect(Value.Check(inspectSchema, invalid)).toBe(false);
    expect(Value.Check(idSchema, { id: "a", other: 1 })).toBe(false);
    expect(Value.Check(listSchema, { other: 1 })).toBe(false);
  });
  it("returns a complete small array rather than truncating pretty-printed lines", () => {
    const data = Array(1000).fill(0);
    const page = payloadPage(data);
    expect(page.nextOffset).toBeNull();
    expect(JSON.parse(page.text)).toEqual(data);
    const result = toolResult({ taskId: "t", view: "event", eventId: "e", payload: page });
    expect(result.content[0].text.split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(MAX_TOOL_BYTES);
  });
  it.each([
    {
      data: Array.from({ length: 2500 }, () => 1e20),
    },
    {
      data: [
        ...Array.from({ length: 400 }, () => 1e20),
        "😀".repeat(2000),
        ...Array.from({ length: 1000 }, () => 1e20),
      ],
    },
    { data: "\u202e".repeat(4500) + "😀" },
  ])("reassembles bounded JSON text pages without changing payload values", ({ data }) => {
    let offset: number | null = 0;
    let text = "";
    let pages = 0;

    while (offset !== null) {
      const payload = payloadPage(data, offset);
      const result = toolResult({ taskId: "t_test", view: "result", untrusted: true, payload });
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(MAX_TOOL_BYTES);
      expect(payload.offset).toBe(Buffer.byteLength(text));
      expect(payload.text).not.toContain("\ufffd");
      expect(payload.text).not.toContain("\u202e");
      text += payload.text;
      offset = payload.nextOffset;

      if (offset !== null) expect(offset).toBeGreaterThan(payload.offset);
      pages++;
    }

    expect(pages).toBeGreaterThan(1);
    expect(JSON.parse(text)).toEqual(data);
  });
  it("rejects invalid and split UTF-8 offsets, without silently truncating oversized responses", () => {
    for (const offset of [-1, 0.5, 2, 99])
      expect(() => payloadPage("😀", offset)).toThrow(/offset/);
    expect(() => toolResult({ data: "x".repeat(MAX_TOOL_BYTES) })).toThrow(/byte budget/);
    expect(JSON.parse(jsonText({ data: "\x1b[31m\u009b\u202e" }))).toEqual({
      data: "\x1b[31m\u009b\u202e",
    });
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
    });

    const parsed: unknown = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ pending: 32, tasks });
    expect(parsed).toHaveProperty("tasks.length", 72);
    expect(parsed).toHaveProperty("tasks.71.id", tasks.at(-1)?.id);

    for (const task of tasks) expect(Array.from(task.name)).toHaveLength(33);
  });
});
