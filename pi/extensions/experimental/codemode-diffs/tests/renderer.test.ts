import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TUnsafe } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { resolveRenderer } from "../renderer.js";
import { toolRenderContext, renderedRows } from "../../../../tests/harness/tool-rendering.js";
import { createIdentityTheme } from "../../../../tests/harness/tui.js";

type ResultRenderer = NonNullable<
  ToolDefinition<TUnsafe<unknown>, unknown, unknown>["renderResult"]
>;

const details = {
  codemodeDiffs: [
    {
      toolCallId: "script/1",
      path: "file.txt",
      diff: Array.from({ length: 20 }, (_, i) => `+${i + 1} new line ${i + 1}`).join("\n"),
    },
  ],
};

const setup = () => {
  const previous: Array<Component | undefined> = [];

  const original: ResultRenderer = (_result, _options, _theme, context) => {
    previous.push(context.lastComponent);

    return context.lastComponent ?? new Text("Original script output", 0, 0);
  };

  const renderer = resolveRenderer("codemode", () => ({ renderResult: original }))?.renderResult;

  if (!renderer) throw new Error("Missing wrapped renderer");

  const render = (data: unknown, expanded = false, lastComponent?: Component, isPartial = false) =>
    renderer(
      { content: [], details: data },
      { expanded, isPartial },
      createIdentityTheme(),
      toolRenderContext({ expanded, lastComponent }),
    );

  return { render, previous };
};

describe("Code Mode diff renderer", () => {
  it("bounds the whole preview by visual rows and expands without duplicating original output", () => {
    const { render, previous } = setup();
    const collapsed = render(details);
    const rows = renderedRows(collapsed, 35);
    expect(rows.join("\n")).toContain("Original script output");
    expect(rows.join("\n")).toContain("Edits (1)");
    expect(rows.join("\n")).not.toContain("+20 new line 20");
    expect(rows.join("\n")).toContain("to expand");
    expect(rows.length).toBeLessThanOrEqual(15);
    const expanded = render(details, true, collapsed);
    expect(expanded).toBe(collapsed);
    const text = renderedRows(expanded, 80).join("\n");
    expect(text).toContain("+20 new line 20");
    expect(text.match(/Original script output/gu)).toHaveLength(1);
    expect(previous[0]).toBeUndefined();
    expect(previous[1]).toBeInstanceOf(Text);
    expect(previous[1]).not.toBe(collapsed);

    const narrow = render({
      codemodeDiffs: [{ toolCallId: "x/1", path: "界".repeat(20), diff: "+1 " + "界".repeat(30) }],
    });

    expect(narrow.render(10).every((line) => visibleWidth(line) <= 10)).toBe(true);
  });

  it.each([undefined, {}, { codemodeDiffs: [{ path: 12, diff: "bad" }] }, { codemodeDiffs: [] }])(
    "leaves old, malformed, or empty results unchanged: %j",
    (data) => {
      const { render } = setup();
      expect(renderedRows(render(data)).join("\n")).toBe("Original script output");
    },
  );

  it("does not display final diffs during partial updates", () => {
    const { render } = setup();
    expect(renderedRows(render(details, false, undefined, true)).join("\n")).toBe(
      "Original script output",
    );
  });

  it("sanitizes persisted paths and diffs at render time and survives invalidation", () => {
    const { render } = setup();

    const component = render(
      {
        codemodeDiffs: [
          {
            toolCallId: "x/1",
            path: "evil\u001b[2J\u202efile\nname",
            diff: "+1 new\u001b[2J\u202e\ttext",
          },
        ],
      },
      true,
    );

    const text = renderedRows(component).join("\n");
    expect(text).toContain("evilfile name");
    expect(text).toContain("+1 new   text");
    expect(text).not.toContain("\u202e");
    // Inspect the unstripped output too: stripping terminal controls would hide an unsafe renderer.
    expect(component.render(80).join("\n")).not.toContain("\u001b[2J");
    component.invalidate();
    expect(renderedRows(component).join("\n")).toBe(text);
  });

  it("passes other tools and missing renderers through unchanged", () => {
    const base = { renderShell: "self" as const };
    expect(resolveRenderer("edit", () => base)).toBe(base);
    expect(resolveRenderer("codemode", () => base)).toBe(base);
    expect(resolveRenderer("codemode", () => undefined)).toBeUndefined();
  });
});
