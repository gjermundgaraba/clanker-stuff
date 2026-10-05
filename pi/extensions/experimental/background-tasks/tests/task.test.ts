import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { describe, it, expect } from "vite-plus/test";
import { Value } from "typebox/value";
import { DEFAULT_TAIL_BYTES, LOG_BYTES } from "../logs.js";
import { inspectOutputSchema, type InspectOutput } from "../output.js";
import { TaskNotices } from "../notices.js";
import { MAX_RECORD_BYTES } from "../protocol.js";
import {
  startSchema,
  inspectSchema,
  idSchema,
  listSchema,
  toolResult,
  MAX_TEXT_BYTES,
} from "../task.js";

/** Fields in task_inspect's order; overrides keep their place. */
const inspection = ({ result, ...overrides }: Partial<InspectOutput> = {}): InspectOutput => ({
  task: {
    id: "t_test",
    name: "failed",
    status: "process_error",
    cleanup: "failed",
    startedAt: 1000,
    endedAt: 2500,
  },
  diagnostic: "process failed",
  ...(result === undefined ? {} : { result }),
  events: [],
  omittedEvents: 0,
  logs: { stdout: "", stderr: "", stdoutOmittedBytes: 0, stderrOmittedBytes: 0 },
  ...overrides,
});

// The largest result a watcher can deliver: its escapes fill the record limit as rendered.
const maxResult = "\u202e".repeat(Math.floor((MAX_RECORD_BYTES - 2) / 6));

// A quote or backslash renders as two bytes. Invalid UTF-8, sanitized to U+FFFD, can render as three.
const escapedLogs = (bytes: number) => ({
  ...inspection().logs,
  stdout: '"'.repeat(bytes),
  stderr: '"'.repeat(bytes),
});

describe("task contracts", () => {
  it("keeps schemas closed and bounded", () => {
    const start = { name: "test", command: "node" };
    expect(Value.Check(startSchema, start)).toBe(true);
    expect(Value.Check(startSchema, { ...start, args: [] })).toBe(true);

    for (const extra of [
      { args: null },
      { args: Array(129).fill("") },
      { args: ["x".repeat(32769)] },
      { unknown: true },
      { protocol: "events" },
      { timeoutMs: 86400001 },
      { timeoutMs: 0 },
    ])
      expect(Value.Check(startSchema, { ...start, ...extra })).toBe(false);
    expect(Value.Check(inspectSchema, { id: "a", tailBytes: 131072 })).toBe(true);

    for (const invalid of [
      null,
      {},
      { id: "a", unknown: true },
      { id: "a", tailBytes: 0 },
      { id: "a", tailBytes: 131073 },
    ])
      expect(Value.Check(inspectSchema, invalid)).toBe(false);
    expect(Value.Check(idSchema, { id: "a", other: 1 })).toBe(false);
    expect(Value.Check(listSchema, { other: 1 })).toBe(false);
  });
  it.each([null, false, 0, "", Array(1000).fill(0), { controls: "\x1b[31m\u009b\u202e" }])(
    "keeps small values complete and identical in all output channels (%j)",
    (result) => {
      const details = inspection({ result });
      const output = toolResult(details);
      expect(Value.Check(inspectOutputSchema, output.structuredContent)).toBe(true);
      expect(output.details).toStrictEqual(details);
      expect(output.structuredContent).toStrictEqual(details);
      expect(JSON.parse(output.content[0].text)).toStrictEqual(details);

      for (const control of ["\x1b", "\u009b", "\u202e"])
        expect(output.content[0].text).not.toContain(control);
    },
  );
  // Valid inputs only: logs up to the maximum tail, and the largest result ahead of them.
  it.each<Partial<InspectOutput>>([
    { logs: { ...inspection().logs, stdout: "😀".repeat(LOG_BYTES / 4) } },
    { result: maxResult, logs: escapedLogs(LOG_BYTES) },
  ])("cuts large text previews from the end, keeping identity and diagnostics", (overrides) => {
    const details = inspection(overrides);
    const output = toolResult(details);
    const text = output.content[0].text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(text).toMatch(/^\{"task":\{"id":"t_test".*"diagnostic":"process failed"/u);
    expect(text).toContain("Incomplete preview");
    expect(text).toContain("tailBytes");
    expect(text).not.toContain("�");
    expect(text).not.toContain("\u202e");
    expect(output.structuredContent).toStrictEqual(details);
    expect(Buffer.byteLength(jsonText(output.structuredContent))).toBeGreaterThan(MAX_TEXT_BYTES);
  });
  it("cuts only log tails with every other part at its cap, so a smaller tailBytes fits", () => {
    expect(Buffer.byteLength(jsonText(maxResult))).toBeLessThanOrEqual(MAX_RECORD_BYTES);

    // U+2028 survives sanitizing and renders as a 6-byte escape. Retention keeps the newest
    // event, a maximal record with the longest key, alone past its byte cap.
    const notices = new TaskNotices();
    notices.record("earlier");
    notices.record(maxResult, "\u2028".repeat(128));

    const atCaps = (logs: InspectOutput["logs"]) =>
      inspection({
        task: { ...inspection().task, name: "\u2028".repeat(80) },
        diagnostic: "\u2028".repeat(500),
        result: maxResult,
        events: notices.events,
        omittedEvents: notices.omitted,
        logs,
      });

    const largest = atCaps(escapedLogs(LOG_BYTES));
    const cut = toolResult(largest).content[0].text;
    expect(cut).toContain("Incomplete preview");
    // Everything ahead of the logs parses whole; toEqual skips the absent logs.
    expect(JSON.parse(`${cut.slice(0, cut.indexOf(',"logs":'))}}`)).toEqual({
      ...largest,
      logs: undefined,
    });

    const details = atCaps(escapedLogs(DEFAULT_TAIL_BYTES / 2));
    expect(JSON.parse(toolResult(details).content[0].text)).toStrictEqual(details);
  });
});
