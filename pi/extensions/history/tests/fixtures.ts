import { acquireEditorHost } from "@clanker-stuff/editor";
import {
  type EditorTheme,
  type Terminal,
  type Component,
  TuiMainScreen,
  TuiAltScreen,
} from "@earendil-works/pi-tui";
import { vi, onTestFinished } from "vite-plus/test";
import type { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createMockTui, createKeybindings } from "../../../tests/harness/tui.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

// Exercise real TUI input dispatch and focus while keeping all terminal I/O inert.
export const createWidgetHarness = (
  host: ReturnType<typeof createExtensionHost>,
  ctx: ExtensionContext,
  mode: "regular" | "fullscreen" = "regular",
  foreign = false,
) => {
  let input: (data: string) => void = () => {};
  const terminal: Terminal = {
    start: (onInput) => {
      input = onInput;
    },
    stop() {},
    drainInput: async () => {},
    write() {},
    columns: 100,
    rows: 40,
    kittyProtocolActive: false,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const plain = new CustomEditor(tui, editorTheme, createKeybindings());
  if (foreign) ctx.ui.setEditorComponent(() => plain);
  const editor = foreign
    ? plain
    : acquireEditorHost(ctx)!.create(tui, editorTheme, createKeybindings());
  editor.setText(ctx.ui.getEditorText());
  vi.spyOn(ctx.ui, "getEditorText").mockImplementation(() => editor.getExpandedText());
  vi.spyOn(ctx.ui, "setEditorText").mockImplementation((text) => editor.setText(text));
  let widget: (Component & { dispose?(): void }) | undefined;
  vi.spyOn(ctx.ui, "setWidget").mockImplementation((_key, content) => {
    if (widget) {
      widget.dispose?.();
      tui.removeChild(widget);
    }
    widget = content?.(tui, ctx.ui.theme);
    if (widget) tui.addChild(widget);
  });
  tui.addInputListener((data) => {
    const result = host.terminalInput(data);
    return result.consumed ? { consume: true } : undefined;
  });
  tui.start();
  onTestFinished(() => {
    widget?.dispose?.();
    tui.stop();
  });
  return {
    tui,
    widget: (width = 80) => widget?.render(width)[0],
    terminalInput: (data: string) => {
      const consumed = widget !== undefined && tui.getFocusedComponent() === widget;
      input(data);
      return { consumed, results: [] };
    },
  };
};
