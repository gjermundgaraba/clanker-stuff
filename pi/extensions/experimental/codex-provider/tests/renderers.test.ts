import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createIdentityTheme, renderComponent } from "../../../../tests/harness/tui.js";
import { createCodexDirectTools } from "../tools/direct.js";
import { summarizePatchText } from "../tools/patch-summary.js";
import { formatProcessMetadata } from "../tools/process-metadata.js";
import {
  execCommandRenderers,
  applyPatchRenderers,
  displayedProcessOutput,
  formatJsonText,
  highlightJsonIfPossible,
} from "../tools/renderers.js";
import { stripVTControlCharacters } from "node:util";
import type { ProcessDisplayDetails } from "../tools/renderers.js";

const theme = createIdentityTheme();

/** Pi's Text pads every line to the viewport width; compare trimmed lines instead. */
const rendered = (component: Component | undefined): string =>
  stripVTControlCharacters(renderComponent(component, 200) ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

const renderContext = (
  overrides: Partial<Parameters<NonNullable<Tool["renderCall"]>>[2]> = {},
) => ({
  args: {},
  argsComplete: true,
  cwd: "/tmp",
  executionStarted: true,
  expanded: false,
  invalidate() {},
  isError: false,
  isPartial: false,
  lastComponent: undefined,
  showImages: false,
  state: {},
  toolCallId: "call-1",
  ...overrides,
});

type Tool = ReturnType<typeof createCodexDirectTools>["definitions"][number];

const tool = (name: string): Tool => {
  const found = createCodexDirectTools().definitions.find((definition) => definition.name === name);

  if (found === undefined) {
    throw new Error(`Missing tool ${name}`);
  }

  return found;
};

type CallArgs = Parameters<NonNullable<Tool["renderCall"]>>[0];

const renderCall = (name: string, args: CallArgs, expanded = false) => {
  const definition = tool(name);

  if (!definition.renderCall) {
    throw new Error(`${name} has no renderCall`);
  }

  return rendered(definition.renderCall(args, theme, renderContext({ args, expanded })));
};

const renderResult = (
  name: string,
  result: { content: Array<{ type: "text"; text: string }>; details: object | undefined },
  options: { expanded?: boolean; isError?: boolean } = {},
) => {
  const definition = tool(name);

  if (!definition.renderResult) {
    throw new Error(`${name} has no renderResult`);
  }

  return rendered(
    definition.renderResult(
      result,
      { expanded: options.expanded ?? false, isPartial: false },
      theme,
      renderContext({ expanded: options.expanded ?? false, isError: options.isError ?? false }),
    ),
  );
};

const exited = (overrides: Partial<ProcessDisplayDetails> = {}): ProcessDisplayDetails => ({
  durationMs: 1234,
  exitCode: 0,
  status: "exited",
  ...overrides,
});

const processResult = (output: string, details: ProcessDisplayDetails) => ({
  content: [
    {
      text:
        output.length === 0
          ? formatProcessMetadata(details)
          : `${output}\n\n${formatProcessMetadata(details)}`,
      type: "text" as const,
    },
  ],
  details,
});

describe("Codex tool renderers", () => {
  beforeAll(() => {
    initTheme("dark");
  });

  it("refreshes shared preview formatting after theme invalidation", () => {
    const changing = createIdentityTheme();
    let color = "\x1b[31m";
    changing.fg = (_name, value) => color + value + "\x1b[0m";

    const components = [
      execCommandRenderers.renderCall(
        { cmd: "echo done", workdir: "/tmp/project" },
        changing,
        renderContext(),
      ),
      execCommandRenderers.renderResult(
        processResult("command output", exited()),
        { expanded: false, isPartial: false },
        changing,
        renderContext(),
      ),
      applyPatchRenderers.renderCall(
        { patch: "*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch" },
        changing,
        renderContext(),
      ),
    ];

    for (const component of components)
      expect(component.render(80).join("\n")).toContain("\x1b[31m");
    color = "\x1b[32m";

    for (const component of components) {
      component.invalidate();
      expect(component.render(80).join("\n")).toContain("\x1b[32m");
    }
  });

  it("refreshes complete process result styling, including warnings, errors and fallbacks", () => {
    const changing = createIdentityTheme();
    let color = "\x1b[31m";
    changing.fg = (_name, value) => color + value + "\x1b[0m";

    const results = [
      processResult("output", exited({ fullOutputPath: "/tmp/result" })),
      processResult("", exited()),
      { content: [{ type: "text" as const, text: "unstructured" }], details: undefined },
    ];

    for (const isError of [false, true])
      for (const result of results) {
        color = "\x1b[31m";

        const component = execCommandRenderers.renderResult(
          result,
          { expanded: false, isPartial: false },
          changing,
          renderContext({ isError }),
        );

        expect(component.render(80).join("\n")).toContain("\x1b[31m");
        color = "\x1b[32m";
        component.invalidate();
        const rows = component.render(80).join("\n");
        expect(rows).toContain("\x1b[32m");
        expect(rows).not.toContain("\x1b[31m");
      }
  });

  it("shows the highlighted command with its working directory", () => {
    const rendered = renderCall("exec_command", { cmd: "ls -la", workdir: "/tmp/project" });
    expect(rendered).toBe("$ ls -la (in /tmp/project)");
  });

  it("collapses long commands and expands them on demand", () => {
    const cmd = ["cat <<'EOF'", "one", "two", "three", "four", "EOF"].join("\n");
    const collapsed = renderCall("exec_command", { cmd });
    expect(collapsed.split("\n")).toHaveLength(4);
    expect(collapsed).toContain("$ cat <<'EOF'");
    expect(collapsed).toContain("… 3 more lines");
    const expanded = renderCall("exec_command", { cmd }, true);
    expect(expanded.split("\n")).toHaveLength(6);
    expect(expanded).not.toContain("to expand");
  });

  it("renders placeholders for streaming and invalid arguments", () => {
    expect(renderCall("exec_command", {})).toBe("$ ...");
    expect(renderCall("exec_command", { cmd: 5 })).toBe("$ [invalid arg]");
  });

  it("shows a live elapsed counter while a command is pending", () => {
    vi.useFakeTimers();

    try {
      const definition = tool("exec_command");
      const invalidate = vi.fn();
      const state = {};

      const context = renderContext({
        args: { cmd: "sleep 5" },
        invalidate,
        isPartial: true,
        state,
      });

      const first = rendered(definition.renderCall?.({ cmd: "sleep 5" }, theme, context));
      expect(first).toMatch(/● running · 0\.0s/u);
      vi.advanceTimersByTime(2500);
      expect(invalidate).toHaveBeenCalledTimes(2);

      const settled = rendered(
        definition.renderCall?.({ cmd: "sleep 5" }, theme, { ...context, isPartial: false }),
      );

      expect(settled).toBe("$ sleep 5");
      vi.advanceTimersByTime(5000);
      expect(invalidate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("strips the model-facing trailer and reports exit status with duration", () => {
    const rendered = renderResult("exec_command", processResult("hello\nworld", exited()));
    expect(rendered).toBe("\nhello\nworld\n\n✓ exit 0 · 1.2s");
  });

  it("keeps the last five lines collapsed and everything expanded", () => {
    const output = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join("\n");
    const collapsed = renderResult("exec_command", processResult(output, exited({ exitCode: 2 })));
    expect(collapsed).toContain("… 4 earlier lines");
    expect(collapsed).not.toContain("line 4\n");
    expect(collapsed).toContain("line 5\nline 6\nline 7\nline 8\nline 9");
    expect(collapsed).toContain("✗ exit 2 · 1.2s");

    const expanded = renderResult("exec_command", processResult(output, exited()), {
      expanded: true,
    });

    expect(expanded).toContain("line 1\nline 2");
    expect(expanded).not.toContain("earlier lines");
  });

  it("describes running sessions, kills, truncation, and empty output", () => {
    const running = renderResult(
      "exec_command",
      processResult("partial", {
        durationMs: 10_000,
        exitCode: null,
        sessionId: 3,
        status: "running",
      }),
    );

    expect(running).toBe("\npartial\n\n● running · session 3 · 10.0s");

    const killed = renderResult(
      "exec_command",
      processResult("", exited({ exitCode: null, status: "killed" })),
    );

    expect(killed).toBe("\n(no output)\n\n■ killed · 1.2s");

    const truncated = renderResult(
      "exec_command",
      processResult("tail", {
        ...exited(),
        fullOutputPath: "/tmp/full.log",
        truncation: { outputLines: 5, totalLines: 50, truncated: true, truncatedBy: "lines" },
      }),
    );

    // Output with a full-output path was rebuilt from that file, so the capture buffer's line
    // truncation does not describe it, even in results persisted before the details changed.
    expect(truncated).toContain("[Full output: /tmp/full.log]");
    expect(truncated).not.toContain("Truncated");
    const esc = String.fromCharCode(0x1b);
    expect(
      renderResult(
        "exec_command",
        processResult("tail", {
          ...exited(),
          fullOutputPath: `/tmp/${esc}]52;c;aGk=\u0007full.log`,
        }),
      ),
    ).toContain("[Full output: /tmp/full.log]");

    const capture = renderResult(
      "exec_command",
      processResult("tail", {
        ...exited(),
        truncation: { outputLines: 5, totalLines: 50, truncated: true, truncatedBy: "lines" },
      }),
    );

    expect(capture).toContain("[Truncated: showing 5 of 50 lines]");
  });

  it("removes the budget truncation header from displayed output", () => {
    const details = { ...exited(), requestedBudgetTruncation: { originalTokenCount: 12_345 } };

    const text = [
      "Warning: truncated output (original token count: 12345)",
      "Total output lines: 400",
      "",
      "head…3000 tokens truncated…tail",
      "",
      formatProcessMetadata(details),
    ].join("\n");

    expect(displayedProcessOutput(text, details)).toBe("head…3000 tokens truncated…tail");
    expect(renderResult("exec_command", { content: [{ text, type: "text" }], details })).toContain(
      "[Model view capped: ~12,345 tokens total]",
    );
  });

  it("renders tool errors in place of output", () => {
    const rendered = renderResult(
      "exec_command",
      { content: [{ text: "spawn failed", type: "text" }], details: undefined },
      { isError: true },
    );

    expect(rendered).toBe("\nspawn failed");
  });

  it("escapes directional marks in stdin while preserving the original value", () => {
    const chars = "\u061c\u200e\u200f\u202e\u2066value\u2069\t\r\n";
    const display = renderCall("write_stdin", { chars, session_id: 7 });
    const encoded = display.slice("stdin session 7 ← ".length);
    expect(JSON.parse(`"${encoded}"`)).toBe(chars);

    for (const control of ["\u061c", "\u200e", "\u200f", "\u202e", "\u2066", "\u2069"])
      expect(display).not.toContain(control);
  });

  it("previews stdin writes and polls", () => {
    expect(renderCall("write_stdin", { chars: "print(1)\n", session_id: 7 })).toBe(
      "stdin session 7 ← print(1)\\n",
    );
    expect(renderCall("write_stdin", { session_id: 7 })).toBe("stdin session 7 (poll)");
    expect(renderCall("write_stdin", { chars: "x".repeat(100), session_id: 1 })).toContain(
      "x".repeat(100),
    );
  });

  it("summarizes partial and complete patches", () => {
    const partial = summarizePatchText(
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-old",
        "+new",
        "+more",
        "*** Add File: b.txt",
        "+hi",
      ].join("\n"),
    );

    expect(partial).toEqual([
      { changed: true, kind: "update", lines: { added: 2, removed: 1 }, path: "src/a.ts" },
      { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "b.txt" },
    ]);

    const moved = summarizePatchText(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "*** Move to: b.ts",
        "*** Delete File: c.ts",
        "*** End Patch",
      ].join("\n"),
    );

    expect(moved).toEqual([
      {
        changed: false,
        from: "a.ts",
        kind: "update",
        lines: { added: 0, removed: 0 },
        path: "b.ts",
      },
      { changed: true, kind: "delete", lines: { added: 0, removed: 0 }, path: "c.ts" },
    ]);
  });

  it("keeps hyperlink labels and drops raw terminal controls from output", () => {
    const esc = String.fromCharCode(0x1b);
    const linked = `see ${esc}]8;;https://a.example${esc}\\docs${esc}]8;;${esc}\\ and ${esc}]8;;https://b.example${esc}\\more${esc}]8;;${esc}\\ here`;
    expect(stripVTControlCharacters(linked)).toBe("see docs and more here");

    const rendered = renderResult(
      "exec_command",
      processResult(
        `${linked}\nbell\u0007 back\bspace\fform\u061c\u200e\u200f\u202e\u2066`,
        exited(),
      ),
    );

    expect(rendered).toContain("see docs and more here\nbell backspaceform");

    for (const control of ["\u061c", "\u200e", "\u200f", "\u202e", "\u2066"])
      expect(rendered).not.toContain(control);
  });

  it("lists patched files in the call header", () => {
    const single = renderCall("apply_patch", {
      patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch",
    });

    expect(single).toBe("apply_patch Update src/a.ts (+1 -1)");

    const multi = renderCall("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: new.txt",
        "+hello",
        "*** Delete File: old.txt",
        "*** Update File: a.ts",
        "*** Move to: b.ts",
        "*** End Patch",
      ].join("\n"),
    });

    expect(multi.split("\n")).toEqual([
      "apply_patch 3 files",
      "  A new.txt (+1 -0)",
      "  D old.txt",
      "  M a.ts → b.ts",
    ]);
    expect(renderCall("apply_patch", {})).toBe("apply_patch ...");
  });

  it("renders patch diffs collapsed and expanded", () => {
    const diff = Array.from({ length: 20 }, (_, index) => `+${index + 1} line ${index + 1}`).join(
      "\n",
    );

    const result = {
      content: [{ text: "Done!\n- a.ts", type: "text" as const }],
      details: {
        changes: [
          { changed: true, kind: "add", lines: { added: 20, removed: 0 }, path: "a.ts" },
          { changed: true, kind: "update", lines: { added: 1, removed: 1 }, path: "moved.ts" },
        ],
        diffs: [{ diff, index: 0 }],
      },
    };

    const collapsed = renderResult("apply_patch", result);
    expect(collapsed).toContain("a.ts\n+1 line 1");
    expect(collapsed).not.toContain("+12 line 12");
    expect(collapsed).toContain("… 10 more lines");
    const expanded = renderResult("apply_patch", result, { expanded: true });
    expect(expanded).toContain("+20 line 20");
    expect(expanded).toContain("moved.ts (diff omitted)");
    expect(expanded).not.toContain("more lines");

    const two = renderResult("apply_patch", {
      content: [],
      details: {
        changes: [
          { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "a.ts" },
          { changed: true, kind: "delete", lines: { added: 0, removed: 1 }, path: "b.ts" },
        ],
        diffs: [
          { diff: "+1 a", index: 0 },
          { diff: "-1 b", index: 1 },
        ],
      },
    });

    expect(two).toBe("a.ts\n+1 a\nb.ts\n-1 b");
    expect(
      renderResult(
        "apply_patch",
        { content: [{ text: "Could not find patch hunk", type: "text" }], details: undefined },
        {
          isError: true,
        },
      ),
    ).toBe("\nCould not find patch hunk");
  });

  it("lists every completed change, distinguishing omitted diffs from bare renames", () => {
    const rendered = renderResult("apply_patch", {
      content: [],
      details: {
        changes: [
          { changed: true, kind: "add", lines: { added: 5000, removed: 0 }, path: "big.ts" },
          { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "small.ts" },
          {
            changed: false,
            from: "old.ts",
            kind: "update",
            lines: { added: 0, removed: 0 },
            path: "new.ts",
          },
          // A fuzzy context match changed the contents without plus or minus lines.
          {
            changed: true,
            from: "a.ts",
            kind: "update",
            lines: { added: 0, removed: 0 },
            path: "b.ts",
          },
          { changed: true, kind: "delete", lines: { added: 0, removed: 4 }, path: "gone.ts" },
          { changed: false, kind: "update", lines: { added: 1, removed: 1 }, path: "same.ts" },
        ],
        diffs: [{ diff: "+1 small", index: 1 }],
      },
    });

    expect(rendered).toBe(
      [
        "big.ts (diff omitted)",
        "small.ts",
        "+1 small",
        "old.ts → new.ts",
        "a.ts → b.ts (diff omitted)",
        "gone.ts (diff omitted)",
        "same.ts (unchanged)",
      ].join("\n"),
    );

    const lone = (change: {
      changed: boolean;
      from?: string;
      kind: string;
      lines?: { added: number; removed: number };
      path: string;
    }) => renderResult("apply_patch", { content: [], details: { changes: [change], diffs: [] } });

    // A lone change repeats its name only when there is more to say than the header shows.
    expect(
      lone({
        changed: false,
        from: "a.ts",
        kind: "update",
        lines: { added: 0, removed: 0 },
        path: "b.ts",
      }),
    ).toBe("");
    expect(
      lone({
        changed: true,
        from: "a.ts",
        kind: "update",
        lines: { added: 0, removed: 0 },
        path: "b.ts",
      }),
    ).toBe("(diff omitted)");
    expect(
      lone({ changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "only.ts" }),
    ).toBe("(diff omitted)");
    expect(
      lone({ changed: false, kind: "update", lines: { added: 1, removed: 1 }, path: "same.ts" }),
    ).toBe("(unchanged)");
    // The same path touched twice keeps both diffs, matched by operation.
    expect(
      renderResult("apply_patch", {
        content: [],
        details: {
          changes: [
            { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "a.txt" },
            { changed: true, kind: "update", lines: { added: 1, removed: 1 }, path: "a.txt" },
          ],
          diffs: [
            { diff: "+1 old", index: 0 },
            { diff: "-1 old\n+1 new", index: 1 },
          ],
        },
      }),
    ).toBe("a.txt\n+1 old\na.txt\n-1 old\n+1 new");
  });

  it("treats anything the trace bound cut as absent rather than authoritative", () => {
    const definition = tool("apply_patch");
    const patch = "*** Begin Patch\n*** Add File: a.ts\n+1\n*** Add File: b.ts\n+2\n*** End Patch";
    const state = {};
    const context = renderContext({ args: { patch }, state });

    const render = (details: unknown) =>
      rendered(
        definition.renderResult?.(
          { content: [], details },
          { expanded: true, isPartial: false },
          theme,
          context,
        ),
      ).replace(/^\n/u, "");

    const header = () => rendered(definition.renderCall?.({ patch }, theme, context)).split("\n");
    const a = { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "a.ts" };

    // A change object cut partway carries the serializer's marker key and lost its tail.
    expect(
      render({
        changes: [
          a,
          { kind: "update", from: "b.ts", path: "c.ts", trace_truncated: true },
          "[values omitted]",
        ],
        diffs: [{ diff: "+1 1\n+2 partial[value truncated]", trace_truncated: true }],
      }),
    ).toBe("a.ts (diff omitted)\n… further changes not recorded");
    expect(header()).toEqual(["apply_patch 2 files", "  A a.ts (+1 -0)", "  A b.ts (+1 -0)"]);

    // The whole diffs value replaced by a limit string must not hide the intact change list.
    const b = { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "b.ts" };
    expect(render({ changes: [a, b], diffs: "[value limit]" })).toBe(
      "a.ts (diff omitted)\nb.ts (diff omitted)",
    );
    expect(header()).toEqual([
      "apply_patch 2 files (+2 -0)",
      "  A a.ts (+1 -0)",
      "  A b.ts (+1 -0)",
    ]);

    // A diff whose text merely ends with the marker is file content, not a cut.
    expect(
      render({ changes: [a], diffs: [{ diff: "+1 hello [value truncated]", index: 0 }] }),
    ).toBe("+1 hello [value truncated]");
  });

  it("withholds totals while any completed count is unknown", () => {
    const definition = tool("apply_patch");

    const patch =
      "*** Begin Patch\n*** Delete File: locked.txt\n*** Add File: a.txt\n+1\n*** End Patch";

    const context = renderContext({ args: { patch }, state: {} });
    definition.renderResult?.(
      {
        content: [],
        details: {
          changes: [
            { changed: true, kind: "delete", path: "locked.txt" },
            { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "a.txt" },
          ],
          diffs: [],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(rendered(definition.renderCall?.({ patch }, theme, context)).split("\n")).toEqual([
      "apply_patch 2 files",
      "  D locked.txt",
      "  A a.txt (+1 -0)",
    ]);
  });

  it("marks a header built from cut arguments as open-ended", () => {
    const cut = (patch: string) =>
      renderCall("apply_patch", { patch: `${patch}[value truncated]` });

    expect(cut("*** Begin Patch\n*** Add File: a.ts\n+1\n*** Add File: b.ts\n+2\n+3")).toBe(
      ["apply_patch 2+ files", "  A a.ts (+1 -0)", "  A b.ts"].join("\n"),
    );
    expect(cut("*** Begin Patch\n*** Add File: a.ts\n+1\n+2")).toBe("apply_patch Add a.ts …");
  });

  it("strips terminal controls from commands, paths, and diffs before styling", () => {
    const esc = String.fromCharCode(0x1b);

    // Assert on raw rows too: the trimmed helper strips ANSI and would hide a live control.
    const raw = (name: string, args: CallArgs) =>
      renderComponent(tool(name).renderCall?.(args, theme, renderContext({ args })), 200) ?? "";

    for (const row of [
      raw("exec_command", { cmd: `echo ${esc}[2Jhi`, workdir: `/tmp/${esc}]0;x\u0007d` }),
      raw("apply_patch", {
        patch: `*** Begin Patch\n*** Delete File: ${esc}]52;c;aGk=\u0007old.txt\n*** End Patch`,
      }),
      raw("view_image", { path: `/tmp/${esc}[31mshot.png` }),
    ]) {
      expect(row).not.toContain(`${esc}]`);
      expect(row).not.toContain(`${esc}[2J`);
      expect(row).not.toContain("\u0007");
    }

    expect(
      renderCall("exec_command", { cmd: `echo ${esc}[2Jhi`, workdir: `/tmp/${esc}]0;x\u0007d` }),
    ).toBe("$ echo hi (in /tmp/d)");
    expect(
      renderCall("apply_patch", {
        patch: `*** Begin Patch\n*** Delete File: ${esc}]52;c;aGk=\u0007old.txt\n*** End Patch`,
      }),
    ).toBe("apply_patch Delete old.txt");
    expect(renderCall("view_image", { path: `/tmp/${esc}[31mshot.png` })).toBe(
      "view_image /tmp/shot.png",
    );

    const hostile = {
      content: [],
      details: {
        changes: [
          { changed: true, kind: "delete", lines: { added: 0, removed: 1 }, path: "a.txt" },
          { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: `b${esc}[2J.txt` },
        ],
        diffs: [
          { diff: `-1 ${esc}]52;c;aGk=\u0007secret\u0007`, index: 0 },
          { diff: "+1 b", index: 1 },
        ],
      },
    };

    expect(renderResult("apply_patch", hostile)).toBe("a.txt\n-1 secret\nb.txt\n+1 b");

    const rawResult =
      renderComponent(
        tool("apply_patch").renderResult?.(
          hostile,
          { expanded: true, isPartial: false },
          theme,
          renderContext(),
        ),
        200,
      ) ?? "";

    expect(rawResult).not.toContain(`${esc}]`);
    expect(rawResult).not.toContain(`${esc}[2J`);
    expect(rawResult).not.toContain("\u0007");
  });

  it("pretty-prints JSON output without altering its tokens", () => {
    const value = { id: 1, list: [1, "two", { three: null }], nested: {}, empty: [] };
    expect(formatJsonText(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
    expect(formatJsonText(JSON.stringify(value, null, 4))).toBe(JSON.stringify(value, null, 2));
    expect(
      formatJsonText('{"id":9007199254740993,"big":1e400,"dup":1,"dup":2,"s":"a{,}\\"b"}'),
    ).toBe(
      [
        "{",
        '  "id": 9007199254740993,',
        '  "big": 1e400,',
        '  "dup": 1,',
        '  "dup": 2,',
        '  "s": "a{,}\\"b"',
        "}",
      ].join("\n"),
    );
    expect(
      stripVTControlCharacters(highlightJsonIfPossible('{"id":9007199254740993}', theme)),
    ).toBe('{\n  "id": 9007199254740993\n}');
    expect(highlightJsonIfPossible("{not json", theme)).toBe("{not json");
    // Indentation grows with depth, so a deeply nested value keeps its original layout.
    const deep = `${"[".repeat(10_000)}0${"]".repeat(10_000)}`;
    const startedAt = performance.now();
    expect(formatJsonText(deep)).toBe(deep);
    expect(stripVTControlCharacters(highlightJsonIfPossible(deep, theme))).toBe(deep);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    const wide = `${"[".repeat(30)}1${"]".repeat(30)}`;
    expect(formatJsonText(wide)).toBe(wide);
    expect(formatJsonText("[[1]]")).toBe("[\n  [\n    1\n  ]\n]");
  });

  it("stops the pending timer once a replaced row is no longer drawn", () => {
    vi.useFakeTimers();

    try {
      const definition = tool("exec_command");
      const invalidate = vi.fn();

      const context = renderContext({
        args: { cmd: "sleep 5" },
        invalidate,
        isPartial: true,
        state: {},
      });

      // A live row is drawn on every tick because Pi re-renders after each invalidation.
      const live = definition.renderCall?.({ cmd: "sleep 5" }, theme, context);

      for (let tick = 0; tick < 5; tick += 1) {
        vi.advanceTimersByTime(1000);
        rendered(live);
      }

      expect(invalidate).toHaveBeenCalledTimes(5);
      // After a transcript rebuild the old row is never drawn again; its timer must give up.
      vi.advanceTimersByTime(60_000);
      expect(invalidate.mock.calls.length).toBeLessThanOrEqual(8);
      expect(vi.getTimerCount()).toBe(0);
      // Pi also stops drawing while an external editor runs. A live row drawn again re-arms.
      const calls = invalidate.mock.calls.length;
      rendered(live);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(invalidate).toHaveBeenCalledTimes(calls + 1);
      rendered(
        definition.renderCall?.({ cmd: "sleep 5" }, theme, { ...context, isPartial: false }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds the completed header from result metadata when the arguments were cut short", () => {
    const definition = tool("apply_patch");

    const patch = [
      "*** Begin Patch",
      "*** Add File: first.txt",
      ...Array.from({ length: 3 }, (_, index) => `+line ${index}`),
      "+partial[value truncated]",
    ].join("\n");

    const state = {};
    const context = renderContext({ args: { patch }, state });
    const pending = rendered(definition.renderCall?.({ patch }, theme, context));
    expect(pending).toBe("apply_patch Add first.txt …");
    definition.renderResult?.(
      {
        content: [],
        details: {
          changes: [
            { changed: true, kind: "add", lines: { added: 5000, removed: 0 }, path: "first.txt" },
            { changed: true, kind: "add", lines: { added: 2, removed: 0 }, path: "second.txt" },
            {
              changed: false,
              from: "a.ts",
              kind: "update",
              lines: { added: 0, removed: 0 },
              path: "b.ts",
            },
          ],
          diffs: [],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect(rendered(definition.renderCall?.({ patch }, theme, context)).split("\n")).toEqual([
      "apply_patch 3 files (+5002 -0)",
      "  A first.txt (+5000 -0)",
      "  A second.txt (+2 -0)",
      "  M a.ts → b.ts",
    ]);
  });

  it("summarizes CRLF patches with the same paths the applied changes report", () => {
    const summary = summarizePatchText(
      "*** Begin Patch\r\n*** Delete File: a.txt\r\n*** Update File: b.txt\r\n*** Move to: c.txt\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n",
    );

    expect(summary).toEqual([
      { changed: true, kind: "delete", lines: { added: 0, removed: 0 }, path: "a.txt" },
      {
        changed: true,
        from: "b.txt",
        kind: "update",
        lines: { added: 1, removed: 1 },
        path: "c.txt",
      },
    ]);
  });

  it("shows the image path and hides attachment notes until expanded", () => {
    expect(renderCall("view_image", { path: "/tmp/shot.png" })).toBe("view_image /tmp/shot.png");

    const result = {
      content: [{ text: "Image loaded", type: "text" as const }],
      details: undefined,
    };

    expect(renderResult("view_image", result)).toBe("");
    expect(renderResult("view_image", result, { expanded: true })).toBe("\nImage loaded");
  });
});
