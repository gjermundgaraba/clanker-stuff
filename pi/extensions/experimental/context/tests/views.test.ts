import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createIdentityTheme,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import { observeRequest } from "../observation.js";
import type { OverlayServices } from "../overlay.js";
import { buildToolsSnapshot } from "../tools.js";
import { ContextViews } from "../views.js";
import { fixtureSnapshot } from "./fixtures/snapshot.js";

const setup = (captured = true) => {
  const tui = createMockTui({ rows: 24 });
  const done = vi.fn<() => void>();

  const views = new ContextViews(
    tui,
    createIdentityTheme(),
    new KeybindingsManager(TUI_KEYBINDINGS),
    fixtureSnapshot({ prompt: "needle state-only instruction" }),
    {
      kind: "request",
      request: captured
        ? observeRequest({ model: "routed", input: "wire-only message" })
        : undefined,
    },
    buildToolsSnapshot([], []),
    { notify: vi.fn<ExtensionUIContext["notify"]>() },
    {
      copyToClipboard: vi.fn<OverlayServices["copyToClipboard"]>(),
      highlightCode,
    },
    done
  );

  views.focused = true;
  const render = (width = 120) => views.render(width).join("\n");

  const press = (...keys: string[]) => {
    for (const key of keys) {
      views.handleInput(key);
      render();
    }
  };

  return { views, tui, done, render, press };
};

describe(ContextViews, () => {
  it("toggles parallel views, keeping independent search and detail state and typing v in search", () => {
    const t = setup();
    expect(t.render()).toContain("state · test/model");
    expect(t.render()).toContain("v request");
    t.press("/", ..."needle".split(""), "v");
    expect(t.render()).toContain("/needlev");
    expect(t.render()).not.toContain("request observation");
    t.press("\u007F", "\r", "v");
    expect(t.render()).toContain("request observation");
    expect(t.render()).toContain("v tools");
    expect(t.render()).not.toContain("state-only instruction");
    expect(t.render()).not.toContain("~");
    t.press("j", "\r");
    expect(t.render()).toContain("wire-only message");
    expect(t.render()).toContain("routed");
    t.press("v");
    expect(t.render()).toContain("tools · registered inventory");
    expect(t.render()).toContain("v state");
    expect(t.render()).not.toContain("~");
    t.press("v");
    expect(t.render()).toContain("/needle");
    expect(t.render()).toContain("state-only instruction");
    t.press("v");
    expect(t.render()).toContain("wire-only message");

    for (const width of [30, 80, 120]) {
      const lines = t.views.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    t.press("\u001B", "\u001B");
    expect(t.done).toHaveBeenCalledOnce();
  });

  it("shows an explicit empty observation instead of substituting stored state", () => {
    const t = setup(false);
    t.press("v");
    expect(t.render()).toContain("No request observed yet");
    expect(t.render()).not.toContain("Provider payload");
    expect(t.render()).not.toContain("state-only instruction");
  });
});
