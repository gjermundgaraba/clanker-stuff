import type { EditorTheme } from "@earendil-works/pi-tui";
import type { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const userEntry = (
  id: string,
  parentId: string | null,
  text: string,
  timestamp: number,
): SessionEntry => ({
  id,
  message: { content: text, role: "user", timestamp },
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  type: "message",
});

export const nonPromptEntries = (parentId: string | null, timestamp: number): SessionEntry[] => [
  {
    id: "assistant",
    message: fauxAssistantMessage("non-prompt assistant content", { timestamp }),
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    type: "message",
  },
  {
    id: "tool",
    message: {
      content: [{ text: "non-prompt tool content", type: "text" }],
      isError: false,
      role: "toolResult",
      timestamp: timestamp + 1,
      toolCallId: "call",
      toolName: "test",
    },
    parentId: "assistant",
    timestamp: new Date(timestamp + 1).toISOString(),
    type: "message",
  },
  {
    id: "custom",
    message: {
      content: "non-prompt custom content",
      customType: "test",
      display: true,
      role: "custom",
      timestamp: timestamp + 2,
    },
    parentId: "tool",
    timestamp: new Date(timestamp + 2).toISOString(),
    type: "message",
  },
];

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

export const createEditor = (host: ReturnType<typeof createExtensionHost>) => {
  const factory = host.getEditorFactory();

  if (!factory) throw new Error("Expected a history editor factory");
  const editor = factory(createMockTui(), editorTheme, createKeybindings());
  editor.render(80);

  return editor;
};

/** Runs one Ctrl+R search through Pi's custom UI, typing keys that must end the search. */
export const search = async (
  host: ReturnType<typeof createExtensionHost>,
  keys: string[],
  onAfterCapture?: () => Promise<void>,
) => {
  const driver = createCustomUiDriver({
    captureRender: "after",
    keys,
    ...(onAfterCapture === undefined ? {} : { onAfterCapture }),
  });

  await host.runShortcut("ctrl+r", host.createContext({ ui: { custom: driver.custom } }));

  return driver.getLastRender() ?? "";
};
