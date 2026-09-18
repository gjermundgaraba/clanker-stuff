import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createMockTui } from "../../../../../tests/harness/tui.js";
import type { RuntimeToolTrace } from "../../code-mode/types.js";
import { stripVTControlCharacters } from "node:util";
import {
  codeModeTool,
  context,
  processTrace,
  result,
  rows,
  theme,
} from "../fixtures/code-mode-rendering.js";

const SUCCESS_BG = "48;2;40;50;40m";

const ERROR_BG = "48;2;60;40;40m";

const PENDING_BG = "48;2;40;40;50m";

const isPaddingRow = (line: string | undefined): boolean =>
  line !== undefined && line.length > 0 && stripVTControlCharacters(line).trim().length === 0;

beforeAll(() => initTheme("dark"));

describe("Code Mode display", () => {
  it("renders through Pi's real shell, expands, resizes, and refreshes theme colors", () => {
    const { definition } = codeModeTool();
    const code = 'await tools.exec_command({cmd: "vp test"});';

    const row = new ToolExecutionComponent(
      "exec",
      "shell",
      { code },
      { showImages: false },
      definition,
      createMockTui(),
      "/tmp/demo",
    );

    row.updateResult({
      ...result([processTrace("failed", "vp test", "test failed", 1)]),
      isError: false,
    });

    for (const width of [40, 60, 80, 120]) {
      const rendered = row.render(width);
      expect(rendered.length).toBeLessThanOrEqual(19);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(stripVTControlCharacters(rendered.join("\n"))).toContain("1 failed");
      // A completed script with a failed command takes the error box, not the success box.
      expect(rendered.slice(1).every((line) => line.includes(ERROR_BG))).toBe(true);
      expect(rendered.join("\n")).not.toContain(SUCCESS_BG);
    }

    row.setExpanded(true);
    expect(stripVTControlCharacters(row.render(120).join("\n"))).toContain(code);
    row.setExpanded(false);
    const dark = row.render(80).join("\n");

    try {
      initTheme("light");
      row.invalidate();
      const light = row.render(80).join("\n");
      expect(light).not.toBe(dark);
      expect(stripVTControlCharacters(light)).toBe(stripVTControlCharacters(dark));
    } finally {
      initTheme("dark");
    }
  });

  it("draws one shared box whose color follows the script and its nested commands", () => {
    const { definition } = codeModeTool();

    const row = new ToolExecutionComponent(
      "exec",
      "shell",
      { code: 'await tools.exec_command({cmd: "echo hi"});' },
      { showImages: false },
      definition,
      createMockTui(),
      "/tmp/demo",
    );

    const boxed = (lines: string[], bg: string) => {
      // Pi emits one unpainted spacer row, then the box: padding, content, padding.
      expect(lines[0]).toBe("");
      expect(isPaddingRow(lines[1])).toBe(true);
      expect(isPaddingRow(lines.at(-1))).toBe(true);
      expect(lines.slice(1).every((line) => line.includes(bg))).toBe(true);
      expect(lines.slice(1).every((line) => visibleWidth(line) === 80)).toBe(true);
    };

    const pending = row.render(80);
    boxed(pending, PENDING_BG);
    expect(stripVTControlCharacters(pending[2] ?? "")).toMatch(/^ Exec/u);

    row.updateResult({ ...result([processTrace("a", "echo hi", "hi")]), isError: false });
    const collapsed = row.render(80);
    boxed(collapsed, SUCCESS_BG);
    expect(stripVTControlCharacters(collapsed[2] ?? "")).toMatch(
      /^ Exec · 1 command · ✓ completed/u,
    );

    row.setExpanded(true);

    const expanded = row
      .render(80)
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .join("\n");

    boxed(row.render(80), SUCCESS_BG);
    // The script and its results share one box: no seam between the call and the result rows.
    expect(expanded).toMatch(/exec_command\(\{cmd: "echo hi"\}\);\n Results · 1 command/u);
  });

  it("keeps a short script preview, then replaces it with commands on the first result frame", () => {
    const tool = codeModeTool();

    const code =
      '// @exec: {"yield_time_ms": 500}\n' +
      Array.from({ length: 10 }, (_, i) => `const value${i} = ${i};`).join("\n");

    const ctx = context();
    const call = tool.renderCall({ code }, theme, ctx);
    expect(rows(call)).toHaveLength(5);
    expect(rows(call)[0]).toContain("Exec @exec");
    expect(rows(call).at(-1)).toContain("to expand");

    const body = tool.renderResult(
      result([processTrace("a", "echo hello", "hello")]),
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );

    expect(rows(call)).toEqual([]);
    expect(rows(body)[0]).toBe("Exec · 1 command · ✓ completed");
    const expanded = rows(tool.renderCall({ code }, theme, { ...ctx, expanded: true }));
    expect(expanded).toHaveLength(11);
    expect(expanded.join("\n")).toContain("const value9 = 9;");
    const long = tool.renderCall({ code: `text("${"x".repeat(1500)}")` }, theme, context());

    for (const width of [40, 60, 80, 120]) expect(rows(long, width)).toHaveLength(5);
  });

  it("puts failed command output inline and restores the complete source and results when expanded", () => {
    const tool = codeModeTool();

    const traces = [
      processTrace("a", "rg --files src", "src/app.ts"),
      processTrace("b", "vp test", "FAIL editor.test.ts\nExpected: 4\nReceived: 3", 1),
    ];

    const returned = JSON.stringify({
      output: "FAIL editor.test.ts\nExpected: 4\nReceived: 3",
      exit_code: 1,
      wall_time_seconds: 1.2,
      original_token_count: 30,
    });

    const data = result(traces, [returned, "Custom summary"]);

    const compact = rows(
      tool.renderResult(data, { expanded: false, isPartial: false }, theme, context()),
    ).join("\n");

    expect(compact).toContain("Exec · 2 commands · 1 failed");
    expect(compact).toMatch(/✓ \$ rg --files src\s+1\.2s/u);
    expect(compact).toMatch(/✗ \$ vp test\s+exit 1 · 1\.2s/u);
    expect(compact).toContain("    FAIL editor.test.ts\n    Expected: 4\n    Received: 3");
    expect(compact.match(/FAIL editor.test.ts/gu)).toHaveLength(1);
    expect(compact).not.toContain("wall_time_seconds");
    expect(compact).toContain("Custom summary");

    const expanded = rows(
      tool.renderResult(data, { expanded: true, isPartial: false }, theme, context(true)),
    ).join("\n");

    expect(expanded).toContain("src/app.ts");
    expect(expanded).toContain("Script output");
    expect(expanded).toContain('"wall_time_seconds": 1.2');
    expect(expanded).toContain('"output": "FAIL editor.test.ts\\nExpected: 4\\nReceived: 3"');
    expect(data.content[1]?.text).toBe(returned);
  });

  it("renders nested freeform patches from the raw string Code Mode passes", () => {
    const tool = codeModeTool();

    const patch =
      "*** Begin Patch\n*** Update File: before.ts\n*** Move to: after.ts\n*** End Patch";

    const trace: RuntimeToolTrace = {
      id: "p",
      input: patch,
      name: "apply_patch",
      result: {
        content: [{ type: "text", text: "Done!\n- after.ts" }],
        details: {
          changes: [
            {
              changed: false,
              from: "before.ts",
              kind: "update",
              lines: { added: 0, removed: 0 },
              path: "after.ts",
            },
          ],
          diffs: [],
        },
      },
      status: "done",
    };

    const compact = rows(
      tool.renderResult(result([trace]), { expanded: false, isPartial: false }, theme, context()),
    ).join("\n");

    expect(compact).toContain("apply_patch Update before.ts → after.ts");
    expect(compact).not.toContain("invalid arg");

    const expanded = rows(
      tool.renderResult(
        result([trace]),
        { expanded: true, isPartial: false },
        theme,
        context(true),
      ),
    ).join("\n");

    expect(expanded).toContain("apply_patch Update before.ts → after.ts");
  });

  it("previews the complete returned output when the trace copy was truncated", () => {
    const tool = codeModeTool();
    const head = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const complete = `${head}\nFAIL final assertion`;
    const trace = processTrace("t", "vp test", complete, 1);
    trace.result = {
      content: [{ type: "text", text: `${head}\n[Trace output truncated]` }],
      details: trace.result?.details,
    };

    const returned = JSON.stringify({
      output: complete,
      exit_code: 1,
      wall_time_seconds: 1.2,
      original_token_count: 30,
    });

    const compact = rows(
      tool.renderResult(
        result([trace], [returned]),
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    ).join("\n");

    expect(compact).toContain("FAIL final assertion");
    expect(compact).not.toContain("[Trace output truncated]");
  });

  it("shows multiline returned process output without its JSON envelope", () => {
    const tool = codeModeTool();
    const trace = processTrace("a", "echo files", "a.ts\nb.ts");

    const data = result(
      [trace],
      [
        JSON.stringify({
          output: "a.ts\nb.ts",
          exit_code: 0,
          wall_time_seconds: 1.2,
          original_token_count: 30,
        }),
      ],
    );

    const output = rows(
      tool.renderResult(data, { expanded: false, isPartial: false }, theme, context()),
    ).join("\n");

    expect(output).toContain("\na.ts\nb.ts\n");
    expect(output).not.toContain("original_token_count");

    const arbitrary = rows(
      tool.renderResult(
        result([], ['{"exit_code":0,"output":"a\\nb"}']),
        { expanded: true, isPartial: false },
        theme,
        context(true),
      ),
    ).join("\n");

    expect(arbitrary).toContain('"output": "a\\nb"');
  });

  it("caps the complete collapsed result and prioritizes failed and running calls", () => {
    const tool = codeModeTool();

    const traces = Array.from({ length: 30 }, (_, i) =>
      processTrace(`t${i}`, `echo task-${i}`, "ok"),
    );

    traces[0] = processTrace("t0", "failed-task", "failure details", 2);
    traces[1] = {
      id: "t1",
      input: { cmd: "running-task" },
      name: "exec_command",
      status: "running",
    };
    const data = result(traces, ["extra output\n".repeat(100)], "running");

    for (const width of [40, 60, 80, 120]) {
      const component = tool.renderResult(
        data,
        { expanded: false, isPartial: true },
        theme,
        context(),
      );

      const raw = component.render(width);
      expect(raw.length).toBeLessThanOrEqual(18);
      expect(raw.every((line) => visibleWidth(line) <= width)).toBe(true);
      const text = rows(component, width).join("\n");
      expect(text).toContain("failed-task");
      expect(text).toContain("running-task");
      expect(text).toContain("26 more calls");
    }

    const expanded = rows(
      tool.renderResult(data, { expanded: true, isPartial: true }, theme, context(true)),
    ).join("\n");

    expect(expanded).toContain("echo task-2");
    expect(expanded).toContain("echo task-29");
  });

  it("reports hidden failures without exceeding the budget", () => {
    const tool = codeModeTool();

    const traces = Array.from({ length: 20 }, (_, i) =>
      processTrace(`t${i}`, `fail-${i}`, "error\n".repeat(100), 1),
    );

    const data = {
      ...result(traces),
      details: { ...result(traces).details, droppedTraceCount: 2 },
    };

    const output = rows(
      tool.renderResult(data, { expanded: false, isPartial: false }, theme, context()),
      120,
    );

    expect(output.length).toBeLessThanOrEqual(16);
    expect(output[0]).toContain("20 failed");
    expect(output.at(-1)).toContain("16 more calls · 16 failed · 2 calls not traced");
  });

  it("does not borrow a running parent's status or start duplicate pending timers", () => {
    vi.useFakeTimers();

    try {
      const tool = codeModeTool();

      const data = result(
        [
          processTrace("done", "finished-command", "done"),
          {
            id: "active",
            input: { cmd: "pending-command" },
            name: "exec_command",
            status: "running",
          },
        ],
        [],
        "running",
      );

      const ctx = { ...context(), isPartial: true };

      const output = rows(
        tool.renderResult(data, { expanded: false, isPartial: true }, theme, ctx),
      );

      expect(output.filter((line) => line.includes("finished-command"))).toEqual([
        expect.stringMatching(/✓ \$ finished-command\s+1\.2s/u),
      ]);
      expect(output.filter((line) => line.includes("running"))).toHaveLength(2);
      tool.renderResult(data, { expanded: true, isPartial: true }, theme, {
        ...ctx,
        expanded: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a yielded process with the later poll that observes its exit", () => {
    const tool = codeModeTool();

    const started: RuntimeToolTrace = {
      id: "start",
      input: { cmd: "long-job" },
      name: "exec_command",
      status: "done",
      result: {
        content: [],
        details: { status: "running", sessionId: 7, exitCode: null, durationMs: 100 },
      },
    };

    const ended: RuntimeToolTrace = {
      ...processTrace("end", "", "finished"),
      name: "write_stdin",
      input: { session_id: 7 },
    };

    const output = rows(
      tool.renderResult(
        result([started, ended]),
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    );

    expect(output[0]).toBe("Exec · 2 calls · ✓ completed");
    expect(output.join("\n")).not.toContain("running");
    expect(output.join("\n")).toContain("yielded · 0.1s");
  });

  it("marks invalid persisted arguments instead of throwing at draw time", () => {
    const exec = codeModeTool();
    const call = exec.renderCall({ code: null }, theme, context());
    expect(rows(call).join("\n")).toBe("Exec [invalid arg]");
    expect(rows(exec.renderCall({}, theme, context())).join("\n")).toBe("Exec …");
    const wait = codeModeTool("wait");
    expect(rows(wait.renderCall({ cell_id: 7 }, theme, context())).join("\n")).toBe(
      "Wait [invalid arg]",
    );
    expect(
      rows(
        wait.renderCall({ cell_id: "cell\u001b[2J-1", terminate: true }, theme, context(true)),
      ).join("\n"),
    ).toBe("Terminate #cell-1");
    // The header is one screen row, so an embedded newline would break Pi's row accounting.
    expect(rows(wait.renderCall({ cell_id: "first\nsecond" }, theme, context(true)))).toEqual([
      "Wait #first second",
    ]);
  });

  it("keeps cell identity terminal-safe and single-line in both views", () => {
    const tool = codeModeTool("wait");

    for (const expanded of [false, true]) {
      for (const terminate of [false, true]) {
        const component = tool.renderCall(
          {
            cell_id: "557\u001b[2J\nsecond",
            terminate,
          },
          theme,
          context(expanded),
        );

        expect(rows(component, 80)).toEqual([`${terminate ? "Terminate" : "Wait"} #557 second`]);

        for (const width of [16, 30, 80]) {
          expect(rows(component, width)).toHaveLength(1);
          expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(component.render(width).join("\n")).not.toContain("\u001b[2J");
        }
      }
    }
  });

  it.each([
    ["exec", "running", "1 failed · running"],
    ["exec", "yielded", "1 failed · running"],
    ["exec", "result", "1 failed · running"],
    ["exec", "terminated", "■ terminated"],
    ["exec", undefined, "1 failed · running"],
    ["wait", "running", "● Waiting for output · 1 running · 1 failed"],
    ["wait", "yielded", "◌ Script still running · 1 running · 1 failed"],
    ["wait", "result", "✗ Finished with tool errors · 1 running · 1 failed"],
    ["wait", "terminated", "■ terminated · 1 running · 1 failed"],
    ["wait", undefined, "✗ Tool errors · 1 running · 1 failed"],
  ])("selects one status for %s / %s with mixed outcomes", (kind, status, expected) => {
    const tool = codeModeTool(kind);

    const data = result([
      processTrace("failed", "false", "failed", 1),
      { id: "running", name: "exec_command", input: { cmd: "sleep 10" }, status: "running" },
    ]);

    const render = (scriptError?: string) =>
      rows(
        tool.renderResult(
          {
            ...data,
            details: { ...data.details, status, scriptError },
          },
          { expanded: false, isPartial: status === "running" },
          theme,
          context(),
        ),
        120,
      );

    expect(render()[kind === "wait" ? 1 : 0]).toContain(expected);
    // Script errors outrank even termination and independently failed nested tools.
    expect(render("boom")[kind === "wait" ? 1 : 0]).toContain("✗ error");
    expect(render("boom")[kind === "wait" ? 1 : 0]).not.toContain("terminated");
  });

  it("distinguishes a pending termination from an ordinary wait", () => {
    const tool = codeModeTool("wait");

    const output = rows(
      tool.renderResult(
        result([], [], "running"),
        {
          expanded: false,
          isPartial: true,
        },
        theme,
        { ...context(), args: { cell_id: "557", terminate: true } },
      ),
    );

    expect(output).toEqual(["Terminate #557", "● Stopping script"]);
  });

  it("lets an observed exit outrank a concurrent poll that still saw the process running", () => {
    const tool = codeModeTool();

    const started: RuntimeToolTrace = {
      id: "start",
      input: { cmd: "long-job" },
      name: "exec_command",
      status: "done",
      result: {
        content: [],
        details: { status: "running", sessionId: 7, exitCode: null, durationMs: 100 },
      },
    };

    const slowPoll: RuntimeToolTrace = {
      ...processTrace("slow", "", "finished"),
      name: "write_stdin",
      input: { session_id: 7, yield_time_ms: 5000 },
    };

    const fastPoll: RuntimeToolTrace = {
      id: "fast",
      input: { session_id: 7, yield_time_ms: 0 },
      name: "write_stdin",
      status: "done",
      result: {
        content: [],
        details: { status: "running", sessionId: 7, exitCode: null, durationMs: 1 },
      },
    };

    const output = rows(
      tool.renderResult(
        result([started, slowPoll, fastPoll]),
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    );

    expect(output[0]).toBe("Exec · 3 calls · ✓ completed");
    expect(output.join("\n")).not.toContain("running");
  });

  it("keeps wait identity and termination visible while sharing the compact layout", () => {
    const tool = codeModeTool("wait");
    const args = { cell_id: "cell-9", terminate: true };
    const ctx = { ...context(), args };
    const call = tool.renderCall(args, theme, ctx);
    expect(rows(call)).toEqual(["Terminate #cell-9"]);

    const output = tool.renderResult(
      result([processTrace("a", "echo hello", "hello")], [], "terminated"),
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );

    expect(rows(call)).toEqual([]);
    expect(rows(output).slice(0, 2)).toEqual(["Terminate #cell-9", "■ terminated · 1 finished"]);
    expect(rows(tool.renderCall({ cell_id: "cell-9" }, theme, context()))).toEqual([
      "Wait #cell-9",
    ]);
  });

  it("shows wait activity and frozen elapsed time through Pi's real shell", () => {
    vi.useFakeTimers();

    try {
      const { definition } = codeModeTool("wait");

      const row = new ToolExecutionComponent(
        "wait",
        "wait-1",
        { cell_id: "557" },
        { showImages: false },
        definition,
        createMockTui(),
        "/tmp/demo",
      );

      const data = result(
        [
          processTrace("done", "echo ready", "ready"),
          { id: "active", name: "exec_command", input: { cmd: "vp test" }, status: "running" },
        ],
        [],
        "running",
      );

      row.updateResult(
        { ...data, details: { ...data.details, elapsedMs: 23_400 }, isError: false },
        true,
      );
      const text = stripVTControlCharacters(row.render(120).join("\n"));
      expect(text).toContain("Wait #557 · 23s elapsed");
      expect(text).toContain("Waiting for output · 1 finished · 1 running");
      expect(text).toContain("$ vp test");
      expect(text).toContain("#557");

      for (const width of [30, 40, 80, 120]) {
        expect(row.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }

      row.setExpanded(true);
      expect(stripVTControlCharacters(row.render(120).join("\n"))).toContain("#557");
      row.setExpanded(false);
      vi.advanceTimersByTime(60_000);
      row.invalidate();
      expect(stripVTControlCharacters(row.render(120).join("\n"))).toBe(text);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains empty waits without guessing activity or output in historical records", () => {
    const tool = codeModeTool("wait");

    const render = (data: Parameters<typeof tool.renderResult>[0]) =>
      rows(
        tool.renderResult(data, { expanded: false, isPartial: false }, theme, {
          ...context(),
          args: { cell_id: "557" },
        }),
        120,
      ).join("\n");

    const empty = result([], [], "yielded");
    expect(render({ ...empty, details: { ...empty.details, elapsedMs: 23_000 } })).toBe(
      "Wait #557 · 23s elapsed\n◌ Script still running · no new output this wait",
    );
    expect(render(empty)).toBe("Wait #557\n◌ Script still running · no new output this wait");
    expect(render(result([], ["new output"], "yielded"))).not.toContain("no new output");
    expect(render({ ...empty, details: { ...empty.details, droppedTraceCount: 1 } })).not.toContain(
      "no new output",
    );
    expect(render({ content: [], details: { status: "yielded" } })).not.toContain("no new output");
    expect(render(result([], [], "result"))).toBe("Wait #557\n✓ completed");
    expect(render(result([], [], "terminated"))).toBe("Wait #557\n■ terminated");
    expect(render({ ...empty, details: { ...empty.details, scriptError: "boom" } })).toContain(
      "✗ error\nboom",
    );

    for (const elapsedMs of [NaN, Infinity, -1]) {
      expect(render({ ...empty, details: { ...empty.details, elapsedMs } })).not.toContain(
        "elapsed",
      );
    }
  });

  it("preserves notifications alongside wait timing and traces", () => {
    const tool = codeModeTool("wait");

    const output = rows(
      tool.renderResult(
        {
          content: [{ type: "text", text: "Checking results" }],
          details: {
            status: "running",
            notification: true,
            elapsedMs: 3000,
            traces: [processTrace("a", "echo ready", "ready")],
          },
        },
        { expanded: false, isPartial: true },
        theme,
        context(),
      ),
    ).join("\n");

    expect(output).toContain("Wait · 3s elapsed");
    expect(output).toContain("Checking results");
    expect(output).toContain("echo ready");
  });
});
