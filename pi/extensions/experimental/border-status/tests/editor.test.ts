import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createStatusIndicator } from "../../../../tests/harness/tui.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { installHistoryEditor } from "../../../history/editor.js";
import { installSkillMentionEditor } from "../../../dollah-skills/editor.js";
import { installBorderEditor } from "../editor.js";
import { renderBorder } from "../layout.js";
import { createEditor } from "./fixtures.js";

it.each([true, false])("composes with history and skill mentions, border first=%s", (first) => {
  const host = createExtensionHost(() => {});

  const ctx = host.createContext({
    sessionManager: { getHeader: () => null, getSessionDir: () => "/sessions" },
  });

  const mounted = vi.fn();

  const install = () =>
    installBorderEditor(ctx, {
      mounted,
      render: (line, width, color) =>
        renderBorder(
          line,
          width,
          [{ owner: "test", key: "x", status: { text: "✉ 3" } }],
          "unicode",
          ctx.ui.theme,
          color,
        ),
    });

  let stop = first ? install() : undefined;
  installHistoryEditor({ type: "session_start", reason: "new" }, ctx, () => [
    { text: "old prompt", timestamp: 1 },
  ]);
  installSkillMentionEditor(ctx, () => ["plan"]);

  if (!first) stop = install();
  const editor = createEditor(host);
  expect(editor).toBeInstanceOf(CustomEditor);
  editor.setText("$plan " + "text ".repeat(50));
  const lines = editor.render(40);
  expect(stripTerminalSequences(lines[0]!)).toContain("✉ 3");
  stop?.();
  const undecorated = editor.render(40);
  expect(undecorated.slice(1)).toEqual(lines.slice(1));
  expect(stripTerminalSequences(undecorated[0]!)).not.toContain("✉ 3");
  expect(mounted).toHaveBeenCalledWith(expect.any(Function));
  editor.setText("");
  editor.handleInput("\u001b[A");
  expect(editor.getText()).toBe("old prompt");
});

it("preserves native status and scroll labels alongside border contributions", () => {
  const host = createExtensionHost(() => {});
  const ctx = host.createContext();

  const release = installBorderEditor(ctx, {
    mounted() {},
    render: (line, width, color) =>
      renderBorder(
        line,
        width,
        [{ owner: "test", key: "count", status: { text: "tasks 3" } }],
        "ascii",
        ctx.ui.theme,
        color,
      ),
  });

  const editor = createEditor(host);
  assert.ok(editor instanceof CustomEditor);
  const indicator = createStatusIndicator("retry");
  indicator.renderInBorder = () => "◉ Retry";
  indicator.renderSpinnerInBorder = () => "◉";

  try {
    editor.setWorkingStatusIndicator(indicator);
    editor.setText(Array.from({ length: 100 }, () => "line").join("\n"));
    const wide = editor.render(80);
    const border = stripTerminalSequences(wide[0]!);
    expect(border).toContain("◉ Retry");
    expect(border).toMatch(/↑ \d+ more/);
    expect(border).toContain("tasks 3");

    for (const width of [1, 4, 12, 40, 80]) {
      const rows = editor.render(width);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(stripTerminalSequences(rows[0]!)).toContain("◉");
    }

    release?.();
    const plain = editor.render(80);
    expect(stripTerminalSequences(plain[0]!)).not.toContain("tasks 3");
    expect(stripTerminalSequences(plain[0]!)).toContain("◉ Retry");
    expect(stripTerminalSequences(plain[0]!)).toMatch(/↑ \d+ more/);
    expect(plain.slice(1)).toEqual(wide.slice(1));
  } finally {
    indicator.dispose();
    release?.();
  }
});

describe("unsupported editors", () => {
  it("leaves foreign editors unchanged and never announces availability", () => {
    const host = createExtensionHost(() => {});

    const ctx = host.createContext({
      sessionManager: { getHeader: () => null, getSessionDir: () => "/sessions" },
    });

    const render = vi.fn(() => ["foreign editor"]);
    ctx.ui.setEditorComponent(() => ({
      render,
      invalidate() {},
      handleInput() {},
      getText: () => "",
      setText() {},
    }));
    const mounted = vi.fn();
    expect(
      installBorderEditor(ctx, {
        render: () => "wrong",
        mounted,
      }),
    ).toBeUndefined();
    expect(createEditor(host).render(80)).toEqual(["foreign editor"]);
    expect(mounted).not.toHaveBeenCalled();
  });
});
