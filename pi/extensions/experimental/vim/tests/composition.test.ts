import { expect, it } from "vite-plus/test";
import { acquireEditorHost } from "@clanker-stuff/editor";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { installHistoryEditor } from "../../../history/editor.js";
import { installSkillMentionEditor } from "../../../dollah-skills/editor.js";
import { installBorderEditor } from "../../border-status/editor.js";
import { renderBorder } from "../../border-status/layout.js";
import { mountVim } from "../runtime.js";

function permutations<T>(items: T[]): T[][] {
  return items.length
    ? items.flatMap((item, i) =>
        permutations(items.filter((_, j) => i !== j)).map((tail) => [item, ...tail]),
      )
    : [[]];
}
it.each(permutations(["vim", "history", "skills", "border"]))(
  "composes in order %j %j %j %j",
  (...order) => {
    const fixture = createExtensionHost(() => {});
    const theme = Object.assign(createIdentityTheme(), {
      fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
      bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
    });
    const ctx = fixture.createContext({
      ui: { theme },
      sessionManager: { getHeader: () => null, getSessionDir: () => "/sessions" },
    });
    for (const name of order) {
      if (name === "vim") mountVim(acquireEditorHost(ctx)!, () => {});
      if (name === "history")
        installHistoryEditor({ type: "session_start", reason: "new" }, ctx, () => [
          { text: "remembered", timestamp: 1 },
        ]);
      if (name === "skills") installSkillMentionEditor(ctx, () => ["plan"]);
      if (name === "border")
        installBorderEditor(ctx, {
          mounted() {},
          render: (line, width, color) =>
            renderBorder(
              line,
              width,
              [{ owner: "test", key: "mode", status: { text: "VIM" } }],
              "unicode",
              theme,
              color,
            ),
        });
    }
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
    const identity = (s: string) => s;
    const editor = acquireEditorHost(ctx)!.create(
      createMockTui(),
      {
        borderColor: identity,
        selectList: {
          description: identity,
          noMatch: identity,
          scrollInfo: identity,
          selectedPrefix: identity,
          selectedText: identity,
        },
      },
      createKeybindings(),
    );
    editor.setText("$plan some 👩‍💻 wrapped text");
    editor.render(12);
    editor.handleInput("\x1b");
    editor.handleInput("gg0v4l");
    const rows = editor.render(12);
    expect(rows.every((row) => visibleWidth(row) <= 12)).toBe(true);
    expect(stripTerminalSequences(rows[0]!)).toContain("VIM");
    expect(rows.slice(1).join("")).toContain("\x1b[44m\x1b[36m$");
    const draft = editor.document.capture();
    const preview = acquireEditorHost(ctx)!.preview();
    preview.show("history");
    preview.close(true);
    expect(editor.document.capture()).toEqual(draft);
  },
);
