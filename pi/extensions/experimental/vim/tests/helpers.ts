import { EditorHost } from "@clanker-stuff/editor";

import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import type { Mode } from "../core/commands.js";
import { mountVim } from "../runtime.js";

const identity = (text: string) => text;

export const setup = (text = "") => {
  const host = new EditorHost(createIdentityTheme);
  let mode: Mode = "insert";
  mountVim(host, (next) => {
    mode = next;
  });

  const editor = host.create(
    createMockTui(),
    {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    },
    createKeybindings({
      "app.interrupt": ["escape"],
      "app.clipboard.pasteImage": ["ctrl+v"],
      "tui.editor.cursorUp": ["up"],
      "tui.editor.cursorDown": ["down"],
      "tui.editor.undo": ["ctrl+-"],
      "tui.input.submit": ["enter"],
      "tui.input.newLine": ["ctrl+j"],
    })
  );

  editor.render(80);
  editor.setText(text);

  const keys = (...inputs: string[]) => {
    for (const input of inputs) {
      editor.handleInput(input);
    }
  };

  const normal = () => {
    keys("\u001B", "gg", "0");
  };

  return { editor, keys, normal, mode: () => mode };
};
