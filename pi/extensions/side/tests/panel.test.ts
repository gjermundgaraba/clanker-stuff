import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { SidePanel } from "../panel.js";
import type { SideSessionController } from "../session.js";

describe("side panel", () => {
  it("preserves the editor draft when the side is already running", () => {
    const submit = vi.fn<(text: string) => boolean>(() => false);
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings() as unknown as KeybindingsManager,
      {
        state: { isRunning: true, transcript: [] },
        submit,
        subscribe: () => vi.fn<() => void>(),
      } as unknown as SideSessionController,
      {
        getMainWorking: () => false,
        onClose: vi.fn<() => void>(),
        onFocus: vi.fn<() => void>(),
        onHide: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
        onToggleFocus: vi.fn<() => void>(),
      }
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
