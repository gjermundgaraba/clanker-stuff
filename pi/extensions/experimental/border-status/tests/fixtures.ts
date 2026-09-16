import type { EditorTheme } from "@earendil-works/pi-tui";
import type { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createMockTui, createKeybindings } from "../../../../tests/harness/tui.js";
export const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    description: (text) => text,
    noMatch: (text) => text,
    scrollInfo: (text) => text,
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
  },
};
export function createEditor(host: ReturnType<typeof createExtensionHost>) {
  const factory = host.getEditorFactory();
  if (!factory) throw new Error("No editor installed");
  return factory(createMockTui(), editorTheme, createKeybindings());
}
