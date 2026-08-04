import { describe, expect, it } from "vitest";

import { createKeybindings } from "../../../tests/harness/tui.js";
import {
  createHelpText,
  decodeAskQuestionIntent,
  formatKeyLabel,
} from "../../dialog/input.js";

const keybindings = createKeybindings({
  "tui.input.submit": ["s"],
  "tui.select.cancel": ["x"],
  "tui.select.confirm": ["y"],
  "tui.select.down": ["j"],
  "tui.select.up": ["k"],
});

describe("ask-question dialog input", () => {
  it("uses remapped keybindings in help text", () => {
    expect(createHelpText(keybindings)).toMatchObject({
      cancel: "x",
      confirm: "y",
      editor: "Pi editor keybindings • s save • x discard",
      move: "k/j",
    });
  });

  it("formats plus keybindings", () => {
    expect([formatKeyLabel("+"), formatKeyLabel("ctrl++")]).toStrictEqual([
      "+",
      "Ctrl++",
    ]);
  });

  it("decodes Kitty CSI-u printable shortcuts", () => {
    expect(decodeAskQuestionIntent(keybindings, "\u001B[110u")).toStrictEqual({
      text: "n",
      type: "printable",
    });
  });
});
