import { describe, expect, it, vi } from "vite-plus/test";

import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { SidePanel } from "../panel.js";

describe("side panel", () => {
  it("preserves the editor draft when the side is already running", () => {
    const submit = vi.fn<(text: string) => boolean>(() => false);
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings(),
      {
        state: { activity: { kind: "running" }, transcript: [] },
        submit,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose: vi.fn<() => void>(),
        onFocus: vi.fn<() => void>(),
        onHide: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
        onToggleFocus: vi.fn<() => void>(),
      },
    );

    for (const character of "draft") {
      panel.handleInput(character);
    }
    panel.handleInput("\r");

    expect(submit).toHaveBeenCalledWith("draft");
    expect(panel.render(80).join("\n")).toContain("draft");
    panel.dispose();
  });
});
