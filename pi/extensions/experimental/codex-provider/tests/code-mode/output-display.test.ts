import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../../tests/harness/tui.js";
import { codeModeOutput } from "../../code-mode/output-display.js";
import type { RuntimeToolResult, RuntimeToolTrace, RuntimeValue } from "../../code-mode/types.js";
import { stripAnsi } from "../../tools/renderers.js";

const theme = createIdentityTheme();
const exited = {
  exit_code: 1,
  original_token_count: 4,
  output: "first\nsecond\n",
  wall_time_seconds: 0.2,
};
const running = {
  exit_code: null,
  output: "still running\n",
  session_id: 12,
  wall_time_seconds: 0.1,
};
const items = (value: RuntimeValue): RuntimeToolResult["content"] => [
  { text: JSON.stringify(value), type: "text" },
];
const trace = (value: RuntimeValue, name = "exec_command"): RuntimeToolTrace => ({
  id: "trace-1",
  input: {},
  name,
  result: { content: [], details: { codeModeResult: value } },
  status: "done",
});
const render = (
  content: RuntimeToolResult["content"],
  traces: readonly RuntimeToolTrace[] = [],
  expanded = false,
) =>
  codeModeOutput(content, traces, theme, expanded).map(({ plain: _plain, ...block }) => ({
    ...block,
    text: stripAnsi(block.text),
  }));

beforeAll(() => initTheme());

describe("Code Mode script output display", () => {
  it("unwraps a captured failed process envelope into real output lines", () => {
    expect(render(items(exited), [trace(exited)])).toEqual([
      { text: "first\nsecond", traceId: "trace-1" },
    ]);
  });

  it("unwraps captured running write_stdin results", () => {
    expect(render(items(running), [trace(running, "write_stdin")])).toEqual([
      { text: "still running", traceId: "trace-1" },
    ]);
  });

  it("matches independent of object key ordering", () => {
    const reordered = {
      wall_time_seconds: 0.2,
      output: "first\nsecond\n",
      original_token_count: 4,
      exit_code: 1,
    };
    expect(render(items(reordered), [trace(exited)])).toEqual([
      { text: "first\nsecond", traceId: "trace-1" },
    ]);
  });

  it("retains arbitrary JSON and unmatched native-looking envelopes", () => {
    const values = [{ output: "user data" }, exited, { ...exited, application: "data" }];
    for (const value of values) {
      expect(render(items(value))).toEqual([{ text: JSON.stringify(value, null, 2) }]);
    }
    const changed = { ...exited, wall_time_seconds: 2 };
    expect(render(items(changed), [trace(exited)])).toEqual([
      { text: JSON.stringify(changed, null, 2) },
    ]);
    const extra = { ...exited, application: "data" };
    expect(render(items(extra), [trace(extra)])).toEqual([
      { text: JSON.stringify(extra, null, 2) },
    ]);
  });

  it("requires a captured direct process result", () => {
    const traces: RuntimeToolTrace[] = [
      trace(exited, "other_tool"),
      { id: "missing", input: {}, name: "exec_command", status: "running" },
      { ...trace(exited), result: { content: [], details: { output: exited.output } } },
    ];
    expect(render(items(exited), traces)).toEqual([{ text: JSON.stringify(exited, null, 2) }]);
  });

  it("keeps the complete original envelope and metadata when expanded", () => {
    expect(render(items(running), [trace(running)], true)).toEqual([
      { text: JSON.stringify(running, null, 2), traceId: "trace-1" },
    ]);
  });

  it("omits empty matched output only when collapsed", () => {
    const empty = { ...exited, output: "" };
    expect(render(items(empty), [trace(empty)])).toEqual([]);
    expect(render(items(empty), [trace(empty)], true)).toEqual([
      { text: JSON.stringify(empty, null, 2), traceId: "trace-1" },
    ]);
  });

  it("sanitizes decoded terminal controls and preserves the captured inputs", () => {
    const value = { ...exited, output: "\u001b[31mred\u001b[0m\r\n\tindented\u0007\u0000\n" };
    const content = items(value);
    const traces = [trace(value)];
    const original = structuredClone({ content, traces });
    expect(render(content, traces)).toEqual([{ text: "red\n   indented", traceId: "trace-1" }]);
    expect({ content, traces }).toEqual(original);
  });

  it("preserves unrelated error text, arrays, invalid JSON, and ignores images", () => {
    const content: RuntimeToolResult["content"] = [
      ...items(exited),
      { text: "Error: script failed\n  at line 2", type: "text" },
      { text: "{not JSON}", type: "text" },
      ...items(["a", "b"]),
      { data: "image", mimeType: "image/png", type: "image" },
    ];
    expect(render(content, [trace(exited)])).toEqual([
      { text: "first\nsecond", traceId: "trace-1" },
      { text: "Error: script failed\n  at line 2" },
      { text: "{not JSON}" },
      { text: JSON.stringify(["a", "b"], null, 2) },
    ]);
  });
});
