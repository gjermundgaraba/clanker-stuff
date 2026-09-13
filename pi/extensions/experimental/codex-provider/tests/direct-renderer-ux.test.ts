import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import {
  applyPatchRenderers,
  DIFF_PREVIEW_LINES,
  PATCH_FILE_PREVIEW_ROWS,
  PrefixedComponent,
  STDIN_PREVIEW_LINES,
  stripAnsi,
  writeStdinRenderers,
} from "../tools/renderers.js";

const theme = createIdentityTheme();
type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const context = (expanded = false): Context => ({
  args: {},
  argsComplete: true,
  cwd: "/tmp",
  executionStarted: true,
  expanded,
  invalidate() {},
  isError: false,
  isPartial: false,
  lastComponent: undefined,
  showImages: false,
  state: {},
  toolCallId: "synthetic",
});
const rows = (component: Component | undefined, width = 80) =>
  component?.render(width).map((line) => stripAnsi(line).trimEnd()) ?? [];

beforeAll(() => initTheme("dark"));

describe("direct tool display boundaries", () => {
  it("keeps styled prefixes inside even the narrowest viewport", () => {
    const component = new PrefixedComponent(
      new Text("first\nsecond", 0, 0),
      "\u001b[31m└ \u001b[0m",
      "  ",
    );
    for (const width of [1, 2, 3, 80]) {
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(rows(component)).toEqual(["└ first", "  second"]);
  });

  it("escapes stdin controls and restores the complete write when expanded", () => {
    const chars = `start\n\t\r\u0003\u001b[2J\u007f\u009bend-${"x".repeat(500)}-tail`;
    const args = { chars, session_id: 7 };
    const collapsed = rows(writeStdinRenderers.renderCall?.(args, theme, context()));
    expect(collapsed).toHaveLength(STDIN_PREVIEW_LINES + 1);
    expect(collapsed.at(-1)).toContain("to expand");
    expect(collapsed.at(-1)).toMatch(/lines · .*to expand$/u);
    const expanded = rows(writeStdinRenderers.renderCall?.(args, theme, context(true)), 2000).join(
      "\n",
    );
    expect(expanded).toBe(
      `stdin session 7 ← start\\n\\t\\r\\u0003\\u001b[2J\\u007f\\u009bend-${"x".repeat(500)}-tail`,
    );
    for (const code of [0, 3, 9, 10, 13, 27, 127, 155]) {
      expect(expanded).not.toContain(String.fromCharCode(code));
    }
  });

  it("caps wrapped patch paths and diffs by screen rows at narrow widths", () => {
    const path = `${"long-directory/".repeat(30)}file.ts`;
    const args = {
      patch: `*** Begin Patch\n*** Add File: ${path}\n+x\n*** Add File: last.ts\n+y\n*** End Patch`,
    };
    const call = applyPatchRenderers.renderCall?.(args, theme, context());
    expect(rows(call, 40)).toHaveLength(PATCH_FILE_PREVIEW_ROWS + 2);
    expect(rows(call, 40).at(-1)).toContain("to expand");
    expect(
      rows(applyPatchRenderers.renderCall?.(args, theme, context(true)), 40).join("\n"),
    ).toContain("last.ts");
    const result = {
      content: [],
      details: {
        changes: [{ changed: true, kind: "add", lines: { added: 1, removed: 0 }, path }],
        diffs: [{ diff: `+1 ${"wide".repeat(300)}END`, index: 0 }],
      },
    };
    const collapsed = rows(
      applyPatchRenderers.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
      40,
    );
    expect(collapsed.filter((line) => line.length > 0)).toHaveLength(DIFF_PREVIEW_LINES + 1);
    expect(collapsed.at(-1)).toContain("to expand");
    const expanded = rows(
      applyPatchRenderers.renderResult?.(
        result,
        { expanded: true, isPartial: false },
        theme,
        context(true),
      ),
      40,
    );
    expect(expanded.join("\n")).toContain("END");
  });

  it("omits unknown deletion counts and gets completed counts on the first row draw", () => {
    const args = { patch: "*** Begin Patch\n*** Delete File: old.txt\n*** End Patch" };
    const ctx = context();
    const pending = applyPatchRenderers.renderCall?.(args, theme, ctx);
    expect(rows(pending).join("\n")).toBe("apply_patch Delete old.txt");
    // Pi invokes both slots on an update before drawing the new call component.
    const call = applyPatchRenderers.renderCall?.(args, theme, { ...ctx, lastComponent: pending });
    applyPatchRenderers.renderResult?.(
      {
        content: [],
        details: {
          changes: [
            { changed: true, kind: "delete", lines: { added: 0, removed: 3 }, path: "old.txt" },
          ],
          diffs: [{ diff: "-1 one\n-2 two", index: 0 }],
        },
      },
      { expanded: false, isPartial: false },
      theme,
      ctx,
    );
    expect(rows(call).join("\n")).toBe("apply_patch Delete old.txt (+0 -3)");
    expect(rows(applyPatchRenderers.renderCall?.(args, theme, context())).join("\n")).toBe(
      "apply_patch Delete old.txt",
    );
  });

  it("omits pure rename zero counts and labels a lone diff among multiple changes", () => {
    const args = {
      patch: "*** Begin Patch\n*** Update File: before.ts\n*** Move to: after.ts\n*** End Patch",
    };
    expect(rows(applyPatchRenderers.renderCall?.(args, theme, context())).join("\n")).toBe(
      "apply_patch Update before.ts → after.ts",
    );
    const result = {
      content: [],
      details: {
        changes: [
          {
            changed: false,
            from: "before.ts",
            kind: "update",
            lines: { added: 0, removed: 0 },
            path: "after.ts",
          },
          { changed: true, kind: "add", lines: { added: 1, removed: 0 }, path: "new.ts" },
        ],
        diffs: [{ diff: "+1 hello", index: 1 }],
      },
    };
    const rendered = rows(
      applyPatchRenderers.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        theme,
        context(),
      ),
    ).join("\n");
    expect(rendered).toContain("new.ts\n+1 hello");
  });

  it.each([0, 1, 2])(
    "keeps original diff associations when change %i is malformed",
    (invalidIndex) => {
      const changes = ["first.ts", "middle.ts", "last.ts"].map((path) => ({
        changed: true,
        kind: "add",
        path,
      }));
      const displayed = rows(
        applyPatchRenderers.renderResult?.(
          {
            content: [],
            details: {
              changes: changes.map((change, index) =>
                index === invalidIndex ? { trace_truncated: true } : change,
              ),
              diffs: changes.map((_change, index) => ({ diff: `+1 content-${index}`, index })),
            },
          },
          { expanded: true, isPartial: false },
          theme,
          context(true),
        ),
      ).filter((line) => line.length > 0);
      expect(displayed).toEqual([
        ...changes.flatMap((change, index) =>
          index === invalidIndex ? [] : [change.path, `+1 content-${index}`],
        ),
        "… further changes not recorded",
      ]);
    },
  );
});
