import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { installHistoryEditor } from "../../../history/editor.js";
import { installSkillMentionEditor } from "../../../dollah-skills/editor.js";
import { installBorderEditor } from "../editor.js";
import { renderBorder } from "../layout.js";
import { createEditor } from "./fixtures.js";

it.each([true, false])(
  "composes with history and skill mentions, border first=%s",
  async (first) => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext({
      sessionManager: { getHeader: () => null, getSessionDir: () => "/sessions" },
    });
    const availability = vi.fn();
    const install = () =>
      installBorderEditor(ctx, {
        bindRender: () => {},
        availability,
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
    await Promise.resolve();
    stop?.();
    const undecorated = editor.render(40);
    expect(undecorated.slice(1)).toEqual(lines.slice(1));
    expect(stripTerminalSequences(undecorated[0]!)).not.toContain("✉ 3");
    await Promise.resolve();
    expect(availability).toHaveBeenCalledWith(true);
    editor.setText("");
    editor.handleInput("\u001b[A");
    expect(editor.getText()).toBe("old prompt");
  },
);

describe("unsupported editors", () => {
  it("leaves foreign editors unchanged and never announces availability", async () => {
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
    const availability = vi.fn();
    installBorderEditor(ctx, {
      render: () => ({ line: "wrong", state: "incompatible" }),
      availability,
      bindRender: () => {},
    });
    expect(createEditor(host).render(80)).toEqual(["foreign editor"]);
    await Promise.resolve();
    expect(availability).not.toHaveBeenCalled();
  });
});

it("reports actual border compatibility asynchronously and coalesces render changes", async () => {
  class AlternateEditor extends CustomEditor {
    unusual = true;
    protected override renderTopBorder(width: number, hidden: number): string {
      return this.unusual ? "custom".padEnd(width, " ") : super.renderTopBorder(width, hidden);
    }
  }
  const host = createExtensionHost(() => {});
  const ctx = host.createContext();
  let current: AlternateEditor | undefined;
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    current = new AlternateEditor(tui, theme, keys);
    return current;
  });
  const availability = vi.fn();
  const stop = installBorderEditor(ctx, {
    bindRender: () => {},
    availability,
    render: (line, width, color) => renderBorder(line, width, [], "unicode", ctx.ui.theme, color),
  });
  const editor = createEditor(host);
  editor.render(80);
  await Promise.resolve();
  expect(availability).not.toHaveBeenCalled();
  current!.unusual = false;
  editor.render(80);
  expect(availability).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(availability).toHaveBeenLastCalledWith(true);
  // A tiny render is not evidence of incompatibility.
  editor.render(1);
  await Promise.resolve();
  expect(availability).toHaveBeenCalledTimes(1);
  current!.unusual = true;
  editor.render(80);
  current!.unusual = false;
  editor.render(80);
  await Promise.resolve();
  expect(availability).toHaveBeenCalledTimes(1);
  current!.unusual = true;
  editor.render(80);
  await Promise.resolve();
  expect(availability).toHaveBeenLastCalledWith(false);
  current!.unusual = false;
  editor.render(80);
  stop();
  await Promise.resolve();
  expect(availability).toHaveBeenCalledTimes(2);
});
