import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { installSkillMentionEditor } from "../editor.js";

const accent = (text: string) =>
  text
    .split("")
    .map((c) => `\x1b[36m${c}\x1b[39m`)
    .join("");

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
      fg: (color: string, text: string) => (color === "accent" ? `\x1b[36m${text}\x1b[39m` : text),
    });

    const ctx = host.createContext({ ui: { theme } });
    installSkillMentionEditor(ctx, () => ["alpha", "plugin:deploy"]);

    const editor = createEditor(host);
    editor.setText("Use $alpha, $plugin:deploy, and not $alphabet or $PATH");

    expect(editor.getText()).toBe("Use $alpha, $plugin:deploy, and not $alphabet or $PATH");
    expect(editor.render(80).join("\n")).toContain(
      "Use " + accent("$alpha") + ", " + accent("$plugin:deploy") + ", and not $alphabet or $PATH",
    );
  });

  it("leaves a competing editor owner usable", () => {
    const host = createExtensionHost(() => {});

    const context = host.createContext({
      ui: {
        theme: Object.assign(createIdentityTheme(), {
          fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
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
    expect(createEditor(host)).toBe(previousEditor);
  });

  it("reads live skill names on every render", () => {
    const host = createExtensionHost(() => {});

    const theme = Object.assign(createIdentityTheme(), {
      fg: (color: string, text: string) => (color === "accent" ? `\x1b[36m${text}\x1b[39m` : text),
    });

    const ctx = host.createContext({ ui: { theme } });
    let names = ["alpha"];
    installSkillMentionEditor(ctx, () => names);
    const editor = createEditor(host);
    editor.setText("Use $alpha and $beta");

    expect(editor.render(80).join("\n")).toContain("Use " + accent("$alpha") + " and $beta");
    names = ["beta"];
    expect(editor.render(80).join("\n")).toContain("Use $alpha and " + accent("$beta"));
  });
});
