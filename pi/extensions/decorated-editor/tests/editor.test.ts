import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { createDecoratedEditor } from "../editor.js";

const identity = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    description: identity,
    noMatch: identity,
    scrollInfo: identity,
    selectedPrefix: identity,
    selectedText: identity,
  },
};

describe("decorated editor", () => {
  it("applies registered decorations without changing editor text", () => {
    const host = createExtensionHost(() => {});
    const decoratedEditor = createDecoratedEditor();
    decoratedEditor.register({
      color: "accent",
      id: "test",
      pattern: /\$alpha/gu,
    });
    const baseTheme = createIdentityTheme();
    const theme = {
      ...baseTheme,
      fg: (color: string, text: string) =>
        color === "accent" ? `<accent>${text}</accent>` : text,
    } as Theme;
    const ctx = host.createContext({ ui: { theme } });
    decoratedEditor.install(ctx);

    const factory = host.getEditorFactory();
    if (!factory) {
      throw new Error("Expected a custom editor factory");
    }
    const editor = factory(
      createMockTui(),
      editorTheme,
      createKeybindings() as KeybindingsManager
    );
    editor.setText("Use $alpha");

    expect(editor.getText()).toBe("Use $alpha");
    expect(editor.render(40).join("\n")).toContain(
      "Use <accent>$alpha</accent>"
    );
  });

  it("decorates a prior editor without changing its input behavior", () => {
    const host = createExtensionHost(() => {});
    const decoratedEditor = createDecoratedEditor();
    const context = host.createContext({
      ui: {
        theme: {
          ...createIdentityTheme(),
          fg: (_color: string, text: string) => `<accent>${text}</accent>`,
        } as Theme,
      },
    });
    const handleInput = vi.fn<(data: string) => void>();
    class PreviousEditor implements EditorComponent {
      #onSubmit: EditorComponent["onSubmit"];
      #text = "Use $alpha";
      getText = () => this.#text;
      handleInput = handleInput;
      invalidate = vi.fn<() => void>();
      render = () => [this.#text];
      setText = (text: string) => {
        this.#text = text;
      };

      get onSubmit() {
        return this.#onSubmit;
      }

      set onSubmit(value: EditorComponent["onSubmit"]) {
        this.#onSubmit = value;
      }
    }
    const previousEditor = new PreviousEditor();
    context.ui.setEditorComponent(() => previousEditor);
    decoratedEditor.register({
      color: "accent",
      id: "test",
      pattern: /\$alpha/gu,
    });
    decoratedEditor.install(context);

    const factory = host.getEditorFactory();
    if (!factory) {
      throw new Error("Expected a custom editor factory");
    }
    const editor = factory(
      createMockTui(),
      editorTheme,
      createKeybindings() as KeybindingsManager
    );

    editor.handleInput("x");
    const onSubmit = vi.fn<(text: string) => void>();
    editor.onSubmit = onSubmit;

    expect(handleInput).toHaveBeenCalledWith("x");
    expect(previousEditor.onSubmit).toBe(onSubmit);
    editor.onSubmit?.("sent");
    expect(onSubmit).toHaveBeenCalledWith("sent");
    expect(editor.render(40)).toStrictEqual(["Use <accent>$alpha</accent>"]);
  });
});
