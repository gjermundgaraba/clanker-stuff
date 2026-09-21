import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createMockTui } from "../../../../../tests/harness/tui.js";
import { PrefixedComponent } from "../../tools/renderers.js";
import { stripVTControlCharacters } from "node:util";
import { codeModeTool, processTrace, result } from "../fixtures/code-mode-rendering.js";
import { observeRenderWork } from "../fixtures/render-work.js";

const code = 'text(await tools.exec_command({cmd: "cat example.ts"}));';

const makeRow = (definition = codeModeTool().definition) =>
  new ToolExecutionComponent(
    "exec",
    "row",
    { code },
    { showImages: false },
    definition,
    createMockTui(),
    "/tmp",
  );

const output = (id: number) =>
  Array.from({ length: 8 }, (_, i) => `file-${id}:${i} ${"output ".repeat(10)}`).join("\n");

beforeAll(() => initTheme("dark"));

describe("Code Mode render work", () => {
  it("reuses expanded output composition until the width changes", () => {
    const row = makeRow();
    row.updateResult({
      ...result([processTrace("a", "cat example.ts", output(1))], [output(2)]),
      isError: false,
    });
    row.setExpanded(true);
    const prefixes = vi.spyOn(PrefixedComponent.prototype, "render");
    const first = row.render(120);
    const text = stripVTControlCharacters(first.join("\n"));
    expect(text).toContain("file-1:0");
    expect(text).toContain("file-1:7");
    expect(text).toContain("file-2:7");
    expect(prefixes).toHaveBeenCalled();
    prefixes.mockClear();

    for (let i = 0; i < 10; i++) expect(row.render(120)).toEqual(first);
    expect(prefixes).not.toHaveBeenCalled();

    const narrow = row.render(60);
    expect(narrow.length).toBeGreaterThan(first.length);
    expect(narrow.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(prefixes).toHaveBeenCalled();
    prefixes.mockClear();
    expect(row.render(60)).toEqual(narrow);
    expect(prefixes).not.toHaveBeenCalled();
  });

  it("caches output, failed-command previews, and script-error previews together", () => {
    const work = observeRenderWork();
    const row = makeRow();
    const data = result([processTrace("failed", "vp test", output(1), 1)], [output(2)]);
    row.updateResult({
      ...data,
      details: { ...data.details, scriptError: "Error: script failed\n".repeat(3) },
      isError: false,
    });
    const first = row.render(120);
    expect(work.layouts).toHaveBeenCalled();
    work.layouts.mockClear();
    work.highlights.mockClear();

    for (let i = 0; i < 10; i++) expect(row.render(120)).toEqual(first);
    expect(work.layouts).not.toHaveBeenCalled();
    expect(work.highlights).not.toHaveBeenCalled();

    row.render(60);
    expect(work.layouts).toHaveBeenCalled();
    expect(work.highlights).not.toHaveBeenCalled();
    work.layouts.mockClear();
    row.render(60);
    expect(work.layouts).not.toHaveBeenCalled();
  });

  it.each(["pending", "expanded", "no-traces"])(
    "retains highlighted scripts across redraws and resizes: %s",
    (mode) => {
      const work = observeRenderWork();
      const row = makeRow();

      if (mode !== "pending") {
        row.updateResult({
          ...result(mode === "expanded" ? [processTrace("a", "cat example.ts", "done")] : []),
          isError: false,
        });
      }

      if (mode === "expanded") row.setExpanded(true);
      row.render(120);
      expect(work.highlights).toHaveBeenCalled();
      work.highlights.mockClear();
      work.layouts.mockClear();
      row.render(120);
      expect(work.layouts).not.toHaveBeenCalled();
      row.render(40);
      expect(work.layouts).toHaveBeenCalled();
      expect(work.highlights).not.toHaveBeenCalled();
      const dark = row.render(40).join("\n");

      try {
        initTheme("light");
        row.invalidate();
        const light = row.render(40).join("\n");
        expect(work.highlights).toHaveBeenCalled();
        expect(light).not.toBe(dark);
        expect(stripVTControlCharacters(light)).toBe(stripVTControlCharacters(dark));
      } finally {
        initTheme("dark");
      }
    },
  );

  it("refreshes data, expansion, and theme without drawing two shells", () => {
    const row = makeRow();
    row.render(120);
    const nextCode = 'text(await tools.exec_command({cmd: "echo changed"}));';
    row.updateArgs({ code: nextCode });
    const data = result([processTrace("a", "echo changed", "changed")]);
    row.updateResult({ ...data, isError: false }, true);
    const partial = row.render(120);
    expect(stripVTControlCharacters(partial.join("\n"))).not.toContain("tools.exec_command");

    // Clicking the result-owned box must still use Pi's normal expand behavior.
    expect(
      row.handleMouse({
        type: "click",
        button: "left",
        x: 3,
        y: 3,
        screenX: 3,
        screenY: 3,
        width: 120,
        height: partial.length,
        shift: false,
        alt: false,
        ctrl: false,
      })?.handled,
    ).toBe(true);
    const expanded = stripVTControlCharacters(row.render(120).join("\n"));
    expect(expanded).toContain(nextCode);
    expect(expanded.split("\n").filter((line) => line.trim() === "Exec")).toHaveLength(1);

    row.updateResult({
      ...result([processTrace("a", "echo changed", "new failure", 1)]),
      isError: false,
    });
    row.setExpanded(false);
    const dark = row.render(120).join("\n");
    expect(stripVTControlCharacters(dark)).toContain("new failure");

    try {
      initTheme("light");
      row.invalidate();
      const light = row.render(120).join("\n");
      expect(light).not.toBe(dark);
      expect(stripVTControlCharacters(light)).toBe(stripVTControlCharacters(dark));
    } finally {
      initTheme("dark");
    }
  });

  it.each([false, true])("honors delegated renderer invalidation (expanded=%s)", (expanded) => {
    let label = "before";

    let invalidate: () => void = () => {
      throw new Error("Nested renderer not prepared");
    };

    const callInvalidated = vi.fn();
    const resultInvalidated = vi.fn();

    const nested: ToolDefinition = {
      name: "custom",
      label: "Custom",
      description: "Test renderer",
      parameters: Type.Object({}),
      async execute() {
        return { content: [], details: undefined };
      },
      renderCall(_args, _theme, context) {
        invalidate = context.invalidate;
        const text = new Text(label, 0, 0);

        return { render: (width) => text.render(width), invalidate: callInvalidated };
      },
      renderResult() {
        const text = new Text(`output ${label}`, 0, 0);

        return { render: (width) => text.render(width), invalidate: resultInvalidated };
      },
    };

    const row = makeRow(codeModeTool("exec", [nested]).definition);
    row.updateResult({
      ...result([{ id: "a", name: "custom", input: {}, status: "done", result: { content: [] } }]),
      isError: false,
    });
    row.setExpanded(expanded);
    expect(stripVTControlCharacters(row.render(120).join("\n"))).toContain("before");
    row.render(120);
    callInvalidated.mockClear();
    resultInvalidated.mockClear();
    label = "after";
    invalidate();
    expect(callInvalidated).toHaveBeenCalled();
    expect(resultInvalidated).toHaveBeenCalled();
    const updated = stripVTControlCharacters(row.render(120).join("\n"));
    expect(updated).toContain("after");
    expect(updated).not.toContain("before");
  });
});
