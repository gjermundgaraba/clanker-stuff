import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const editor = vi.hoisted(() => ({
  install: vi.fn<(ctx: ExtensionContext) => void>(),
  register: vi.fn<(data: unknown) => void>(),
}));

vi.mock(import("../editor.js"), () => ({
  REGISTER_DECORATION_EVENT: "decorated-editor:register" as const,
  createDecoratedEditor: () => editor,
}));

describe("decorated-editor registration", () => {
  it("delegates decoration registration and editor installation", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const decoration = {
      color: "accent",
      id: "test",
      pattern: /\$alpha/gu,
    };

    host.events.emit("decorated-editor:register", decoration);
    await host.emitSessionStart(ctx);

    expect(editor.register).toHaveBeenCalledExactlyOnceWith(decoration);
    expect(editor.install).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
