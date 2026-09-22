import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { renderedRows, toolRenderContext } from "../../../../tests/harness/tool-rendering.js";
import extension from "../index.js";
import { taskRenderers } from "../renderers.js";

type Details = NonNullable<
  Parameters<ReturnType<typeof taskRenderers>["renderResult"]>[0]["details"]
>;

const theme = createIdentityTheme();

type TaskDetails = Extract<Details, { trust: string }>["task"];

const task: TaskDetails = {
  id: "t_123",
  name: "Build",
  pid: 42,
  status: "completed",
  cleanup: "clean",
  startedAt: 0,
  endedAt: 1500,
  exitCode: 0,
  signal: null,
  abandoned: false,
};

const list = (tasks: TaskDetails[], counts = { pending: 0, evictedEvents: 0 }): Details => ({
  ...counts,
  tasks,
  omittedProgress: 0,
  evictedTasks: 0,
  historyStorageError: undefined,
  lifetime: "",
});

const logs = {
  stdout: "",
  stderr: "",
  stdoutOmittedBytes: 0,
  stderrOmittedBytes: 0,
  directory: "",
  storageError: undefined,
};

const summary = (overrides: Partial<Extract<Details, { trust: string }>> = {}): Details => ({
  task,
  diagnostic: undefined,
  resultAvailable: false,
  events: [],
  logs,
  trust: "",
  ...overrides,
});

const render = (details: Details, expanded = false, name = "task_inspect") =>
  taskRenderers(name).renderResult(
    { content: [{ type: "text", text: JSON.stringify(details) }], details },
    { expanded, isPartial: false },
    theme,
    toolRenderContext({ expanded }),
  );

beforeAll(() => initTheme("dark"));

describe("task presentation", () => {
  it("registers both display slots and renders the details it returns", async () => {
    const host = createExtensionHost(extension);
    await host.emitSessionStart();

    for (const { definition } of host.getRegisteredTools().values()) {
      expect(definition.renderCall).toBeTypeOf("function");
      expect(definition.renderResult).toBeTypeOf("function");
    }

    const result = await host.runTool("task_list", {});
    expect(result.details).toMatchObject({ tasks: [], pending: 0 });

    const [content] = result.content;
    assert.ok(content?.type === "text");
    expect(JSON.parse(content.text)).toStrictEqual(JSON.parse(JSON.stringify(result.details)));

    const text = renderedRows(
      taskRenderers("task_list").renderResult(
        { content: result.content, details: list([]) },
        { expanded: false, isPartial: false },
        theme,
        toolRenderContext(),
      ),
    ).join("\n");

    expect(text).toContain("0 tasks · 0 pending notifications");
    expect(text).not.toMatch(/held|wakes|unknown/);
  });
  it("summarizes pending notifications, task status and cleanup failures", () => {
    const value = list([task, { ...task, id: "t_failed", cleanup: "failed" }], {
      pending: 2,
      evictedEvents: 3,
    });

    const text = renderedRows(render(value, false, "task_list")).join("\n");
    expect(text).toContain("2 tasks · 2 pending notifications");
    expect(text).toContain("✓ completed · Build · t_123 · exit 0");
    expect(text).toContain("cleanup failed");
    expect(text).toContain("evictedEvents: 3");
    expect(text).not.toContain('"tasks"');
  });
  it("keeps cleanup warnings visible before long identities and bounded failure groups", () => {
    const failed: TaskDetails = {
      ...task,
      id: "t_12345678-1234-1234-1234-123456789abc",
      name: "x".repeat(32),
      cleanup: "failed",
    };

    for (const count of [1, 12]) {
      const value = list(
        Array.from({ length: count }, () => failed),
        { pending: count, evictedEvents: 0 },
      );

      const component = render(value, false, "task_list");
      const rows = renderedRows(component, 20);
      expect(rows.join(" ")).toContain(`Cleanup failed: ${count} task`);
      expect(rows.length).toBeLessThan(20);
      expect(component.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
    }

    for (const name of ["task_start", "task_stop", "task_inspect"]) {
      const value = name === "task_inspect" ? summary({ task: failed }) : failed;
      expect(renderedRows(render(value, false, name), 20)[0]).toBe("Cleanup failed");
    }
  });
  it("shows readable log tails, truncation warnings and expanded events", () => {
    const value = summary({
      diagnostic: "check this",
      resultAvailable: true,
      events: [{ id: "e_one", seq: 1, reason: "observation" }],
      logs: {
        ...logs,
        stdout: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
        stderr: "error detail",
        stdoutOmittedBytes: 200,
        directory: "/tmp/logs",
        storageError: "disk full",
      },
    });

    const collapsed = renderedRows(render(value)).join("\n");
    expect(collapsed).toContain("line 29");
    expect(collapsed).not.toContain("line 0\n");
    expect(collapsed).toContain("earlier lines");
    expect(collapsed).toContain("200 earlier bytes omitted");
    expect(collapsed).toContain("disk full");
    expect(collapsed).toContain("check this");
    expect(collapsed).toContain("result available");
    const expanded = renderedRows(render(value, true)).join("\n");
    expect(expanded).toContain("line 0\n");
    expect(expanded).toContain("e_one · observation");
    expect(expanded).toContain("PID 42 · 1.5s");
  });
  it("unwraps payload pages but preserves pagination and exact payload tokens", () => {
    const text = renderedRows(
      render({
        taskId: "t_123",
        view: "result",
        untrusted: true,
        payload: {
          encoding: "json",
          text: '{"id":9007199254740993}',
          offset: 100,
          nextOffset: 200,
          totalBytes: 400,
        },
      }),
    ).join("\n");

    expect(text).toContain('{"id":9007199254740993}');
    expect(text).toContain("Byte offset 100 · 400 bytes total");
    expect(text).toContain("next offset 200");
    expect(text).toContain("untrusted output");
  });
  it("bounds wrapped calls, sanitizes controls, and expands all argv", () => {
    const args = {
      name: "build\u001b[2J",
      command: "node",
      args: ["x".repeat(1000) + "END"],
      cwd: "/tmp",
    };

    const call = taskRenderers("task_start").renderCall;
    const component = call(args, theme, toolRenderContext());

    for (const width of [1, 2, 20, 80]) {
      const rows = component.render(width);
      expect(rows.length).toBeLessThanOrEqual(4);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(rows.join("\n")).not.toContain("\u001b[2J");
    }

    const expanded = renderedRows(call(args, theme, toolRenderContext({ expanded: true }))).join(
      "\n",
    );

    expect(expanded).toContain("END");
    expect(expanded).toContain("cwd: /tmp");
  });
  it("preserves original executable and argument values without emitting terminal controls", () => {
    const command = "/tmp/my program\t\u001b[2J\u061c\u200e\u200f";

    const argv = [
      "",
      "a\tb",
      "a\rb",
      "line\nnext",
      "\u001b[2J",
      'quote"slash\\',
      "\u007f\u0085\u009b31m",
      "\u061c\u200e\u200f\u2028\u2029\u202e\u2066value\u2069",
      "日本語🙂",
    ];

    const args = { name: "Argument test", command, args: argv };
    const original = structuredClone(args);

    for (const expanded of [false, true]) {
      const component = taskRenderers("task_start").renderCall(
        args,
        theme,
        toolRenderContext({ expanded }),
      );

      const rows = renderedRows(component, 2000);
      const displayed = rows[1];
      assert.ok(displayed);
      // Treat each displayed token as a JSON string, not as shell syntax.
      const tokens = displayed.match(/"(?:\\.|[^"\\])*"/gu) ?? [];

      // oxlint-disable-next-line anti-slop/no-unknown-returns -- Parsed renderer tokens are checked by the deep-equality assertion below.
      const parsed = tokens.map((token): unknown => {
        const value: unknown = JSON.parse(token);

        return value;
      });

      expect(parsed).toEqual([command, ...argv]);
      expect(component.render(2000).join("")).not.toMatch(
        /\p{Cc}|[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
      );
    }

    expect(args).toEqual(original);
  });
  it("sanitizes log display while preserving newlines and normalizing tabs", () => {
    const value = summary({
      logs: {
        ...logs,
        stdout: "first\tcolumn\nsecond\u001b[2J\r\u0001\u007f\u009f\u202e\u2066\u2069",
      },
    });

    const text = renderedRows(render(value, true)).join("\n");
    expect(text).toContain("first   column\nsecond");
    expect(text.replaceAll("\n", "")).not.toMatch(/\p{Cc}|[\u202a-\u202e\u2066-\u2069]/u);
  });
  it("omits nullable process exit metadata", () => {
    const text = renderedRows(render({ ...task, exitCode: null }, true, "task_stop")).join("\n");
    expect(text).toContain("✓ completed");
    expect(text).not.toContain("exit null");
  });

  it("renders incomplete calls without requiring execution-ready arguments", () => {
    const call = taskRenderers("task_start").renderCall;

    const partial = renderedRows(
      call(
        { name: "Build" },
        theme,
        toolRenderContext({ isPartial: true, executionStarted: false }),
      ),
    ).join("\n");

    expect(partial).toContain("Build");
    expect(partial).toContain("…");
  });

  it("keeps results without details and errors visible as text", () => {
    const renderer = taskRenderers("task_stop").renderResult;

    for (const text of [
      "old result",
      "{bad",
      '{"new_field":"retained"}',
      '{"id":"old","legacy":"retained"}',
    ]) {
      const result = { content: [{ type: "text" as const, text }], details: undefined };
      expect(
        renderedRows(
          renderer(result, { expanded: false, isPartial: false }, theme, toolRenderContext()),
        ).join("\n"),
      ).toContain(text);
    }

    expect(
      renderedRows(
        renderer(
          { content: [{ type: "text", text: "Failed\u001b[2J" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          toolRenderContext({ isError: true }),
        ),
      ).join("\n"),
    ).toBe("Failed");
  });
});
