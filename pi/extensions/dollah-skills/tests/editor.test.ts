import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { installSkillMentionEditor } from "../editor.js";

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

const createEditor = (host: ReturnType<typeof createExtensionHost>) => {
  const factory = host.getEditorFactory();
  if (!factory) {
    throw new Error("Expected a custom editor factory");
  }
  return factory(createMockTui(), editorTheme, createKeybindings());
};

describe("skill mention editor", () => {
  it("highlights exact loaded skill mentions without changing editor text", () => {
    const host = createExtensionHost(() => {});
    const theme = Object.assign(createIdentityTheme(), {
      fg: (color: string, text: string) => (color === "accent" ? `<accent>${text}</accent>` : text),
    });
    const ctx = host.createContext({ ui: { theme } });
    installSkillMentionEditor(ctx, () => ["alpha", "plugin:deploy"]);

    const editor = createEditor(host);
    editor.setText("Use $alpha, $plugin:deploy, and not $alphabet or $PATH");

    expect(editor.getText()).toBe("Use $alpha, $plugin:deploy, and not $alphabet or $PATH");
    expect(editor.render(80).join("\n")).toContain(
      "Use <accent>$alpha</accent>, <accent>$plugin:deploy</accent>, and not $alphabet or $PATH",
    );
  });

  it("decorates a previous editor in place", () => {
    const host = createExtensionHost(() => {});
    const context = host.createContext({
      ui: {
        theme: Object.assign(createIdentityTheme(), {
          fg: (_color: string, text: string) => `<accent>${text}</accent>`,
        }),
      },
    });
    const previousEditor = {
      getText: () => "Use $alpha",
      handleInput: vi.fn<(data: string) => void>(),
      invalidate: vi.fn<() => void>(),
      render: () => ["Use $alpha"],
      setText: vi.fn<(text: string) => void>(),
    } satisfies EditorComponent;
    context.ui.setEditorComponent(() => previousEditor);
    installSkillMentionEditor(context, () => ["alpha"]);

    const editor = createEditor(host);

    expect(editor).toBe(previousEditor);
    expect(editor.render(40)).toStrictEqual(["Use <accent>$alpha</accent>"]);
  });

  it("reads live skill names on every render", () => {
    const host = createExtensionHost(() => {});
    const theme = Object.assign(createIdentityTheme(), {
      fg: (color: string, text: string) => (color === "accent" ? `<accent>${text}</accent>` : text),
    });
    const ctx = host.createContext({ ui: { theme } });
    let names = ["alpha"];
    installSkillMentionEditor(ctx, () => names);
    const editor = createEditor(host);
    editor.setText("Use $alpha and $beta");

    expect(editor.render(80).join("\n")).toContain("Use <accent>$alpha</accent> and $beta");
    names = ["beta"];
    expect(editor.render(80).join("\n")).toContain("Use $alpha and <accent>$beta</accent>");
  });
});
