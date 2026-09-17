import { EditorHost } from "@clanker-stuff/editor";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { mountVim } from "../runtime.js";
import type { Mode } from "../core/commands.js";

const identity = (text: string) => text;
export function setup(text = "") {
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
      "app.interrupt": ["\x1b"],
      "app.clipboard.pasteImage": ["\x16"],
      "tui.editor.cursorUp": ["\x1b[A"],
      "tui.editor.cursorDown": ["\x1b[B"],
      "tui.editor.undo": ["\x1f"],
      "tui.input.submit": ["\r"],
      "tui.input.newLine": ["\n"],
    }),
  );
  editor.render(80);
  editor.setText(text);
  const keys = (...inputs: string[]) => {
    for (const input of inputs) editor.handleInput(input);
  };
  const normal = () => keys("\x1b", "gg", "0");
  return { editor, host, keys, normal, mode: () => mode };
}
