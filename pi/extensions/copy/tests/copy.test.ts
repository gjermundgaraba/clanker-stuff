import type {
  KeybindingsManager,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";

const { copyToClipboard } = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyToClipboard,
}));

const copyModule = await import("../index.js");
const extension = copyModule.default;

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

const assistantEntry = (
  text: string,
  options: {
    id?: string;
    parentId?: string | null;
    stopReason?: "aborted" | "stop";
  } = {}
): SessionEntry => ({
  id: options.id ?? "assistant",
  message: {
    api: "test",
    content: text ? [{ text, type: "text" }] : [],
    model: "test",
    provider: "test",
    role: "assistant",
    stopReason: options.stopReason ?? "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  },
  parentId: options.parentId ?? null,
  timestamp: new Date().toISOString(),
  type: "message",
});

const createEditor = (host: ReturnType<typeof createExtensionHost>) => {
  const factory = host.getEditorFactory();
  if (!factory) {
    throw new Error("Expected a custom editor factory");
  }
  return factory(
    createMockTui(),
    editorTheme,
    createKeybindings() as KeybindingsManager
  );
};

const setup = async (entries: SessionEntry[] = [assistantEntry("answer")]) => {
  const host = createExtensionHost(extension, {
    entries,
    leafId: entries.at(-1)?.id ?? null,
  });
  await host.ready;
  await host.emitSessionStart();
  return { editor: createEditor(host), host };
};

describe("copy", () => {
  beforeEach(() => {
    copyToClipboard.mockReset();
    copyToClipboard.mockResolvedValue();
  });

  it("copies the last assistant message and notifies", async () => {
    const { editor, host } = await setup([assistantEntry("last answer")]);
    const onSubmit = vi.fn<(text: string) => void>();
    editor.setText("/copy");
    editor.onSubmit = onSubmit;

    editor.onSubmit?.("/copy");
    await vi.waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith("last answer");
    });

    expect(editor.getText()).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(host.getNotifications()).toContainEqual({
      message: "Copied last agent message to clipboard.",
      type: "info",
    });
  });

  it("skips an empty aborted response", async () => {
    const { editor } = await setup([
      assistantEntry("previous answer"),
      assistantEntry("", {
        id: "aborted",
        parentId: "assistant",
        stopReason: "aborted",
      }),
    ]);
    editor.onSubmit = () => {};

    editor.onSubmit?.("/copy");
    await vi.waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(
        "previous answer"
      );
    });
  });

  it("delegates other submissions through a previous editor", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const onSubmit = vi.fn<(text: string) => void>();
    const previous = {
      getText: () => "hello",
      handleInput: vi.fn<(data: string) => void>(),
      invalidate: vi.fn<() => void>(),
      onSubmit,
      render: () => ["hello"],
      setText: vi.fn<(text: string) => void>(),
    } satisfies EditorComponent;
    ctx.ui.setEditorComponent(() => previous);
    await host.ready;
    await host.emitSessionStart(ctx);

    const editor = createEditor(host);
    editor.onSubmit = onSubmit;
    editor.onSubmit?.("hello");

    expect(editor).toBe(previous);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("hello");
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("notifies when there is no assistant message", async () => {
    const { editor, host } = await setup([]);
    editor.onSubmit = () => {};

    editor.onSubmit?.("/copy");
    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "No agent messages to copy yet.",
        type: "error",
      });
    });

    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("notifies when the clipboard write fails", async () => {
    copyToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const { editor, host } = await setup();
    editor.onSubmit = () => {};

    editor.onSubmit?.("/copy");
    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "clipboard unavailable",
        type: "error",
      });
    });
  });
});
