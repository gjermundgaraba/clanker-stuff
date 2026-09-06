import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { ExtensionUIContext } from "../../../tests/harness/agent-session.js";
import { createCustomUiDriver } from "../../../tests/harness/tui.js";
import extension from "../index.js";

describe("tool selection with a real AgentSession", () => {
  it("keeps untouched branches at the original baseline after reload", async () => {
    initTheme("dark");
    const ui = createCustomUiDriver({ keys: [" ", "\u001B"] });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    // SAFETY: The picker uses only custom and notify from the UI context.
    const uiContext = Object.assign({} as ExtensionUIContext, { custom: ui.custom, notify });
    const harness = await createAgentSessionHarness({
      extensionFactories: [extension],
      mode: "tui",
      uiContext,
    });
    const { session, sessionManager } = harness;

    try {
      const initialTools = session.getActiveToolNames();
      const root = sessionManager.appendCustomEntry("test-node", { name: "root" });
      const branchB = sessionManager.appendCustomEntry("test-node", { name: "B" });
      sessionManager.branch(root);
      sessionManager.appendCustomEntry("test-node", { name: "A" });

      await session.prompt("/tools");
      expect(session.getActiveToolNames()).not.toContain("read");
      const selected = sessionManager.getLeafEntry();
      if (!selected) throw new Error("Missing selection entry");

      await session.navigateTree(branchB);
      expect(session.getActiveToolNames()).toStrictEqual(initialTools);
      await session.navigateTree(selected.id);

      await session.reload();
      expect(session.getActiveToolNames()).not.toContain("read");
      await session.navigateTree(branchB);
      expect(session.getActiveToolNames()).toStrictEqual(initialTools);
      await session.reload();
      expect(session.getActiveToolNames()).toStrictEqual(initialTools);
      await session.navigateTree(selected.id);
      expect(session.getActiveToolNames()).not.toContain("read");
      expect(notify).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });
});
