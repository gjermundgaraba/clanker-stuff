import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
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
