import { acquireEditorHost } from "@clanker-stuff/editor";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { installSkillMentionEditor } from "../../../dollah-skills/editor.js";
import { mountVim } from "../runtime.js";

const identity = (s: string) => s;

describe("composition", () => {
  // Either decorator may acquire the shared editor first; a border contributor joins afterwards.
  it.each([
    ["vim", "skills"],
    ["skills", "vim"],
  ])("composes in order %j %j with a border contribution", (...order) => {
    const fixture = createExtensionHost(() => {});

    const theme = Object.assign(createIdentityTheme(), {
      fg: (_color: string, text: string) => `\u001B[36m${text}\u001B[39m`,
      bg: (_color: string, text: string) => `\u001B[44m${text}\u001B[49m`,
    });

    const ctx = fixture.createContext({
      ui: { theme },
      sessionManager: {
        getHeader: () => null,
        getSessionDir: () => "/sessions",
      },
    });

    for (const name of order) {
      if (name === "vim") {
        mountVim(acquireEditorHost(ctx)!, () => {});
      }

      if (name === "skills") {
        installSkillMentionEditor(ctx, () => ["plan"]);
      }
    }

    acquireEditorHost(ctx)!.contribute("border", {
      render: (line, width) => truncateToWidth(`─ NORMAL ${line}`, width, ""),
    });

    expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();

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
      createKeybindings()
    );

    editor.setText("$plan some 👩‍💻 wrapped text");
    editor.render(12);
    editor.handleInput("\u001B");
    editor.handleInput("gg0v4l");
    const rows = editor.render(12);
    expect(rows.every((row) => visibleWidth(row) <= 12)).toBe(true);
    expect(stripTerminalSequences(rows[0]!)).toContain("NORMAL");
    expect(rows.slice(1).join("")).toContain("\u001B[44m\u001B[36m$");
    editor.handleInput("d");
    expect(editor.getText()).toBe(" some 👩‍💻 wrapped text");
  });
});
