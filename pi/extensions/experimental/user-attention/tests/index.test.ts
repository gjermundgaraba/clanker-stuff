import { describe, expect, it } from "vite-plus/test";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

describe("independent user attention", () => {
  it.each(["tui", "rpc"] as const)(
    "keeps the %s call as the only record, notifying only non-TUI clients",
    async (mode) => {
      const host = createExtensionHost(extension);
      const ctx = host.createToolContext({ mode });

      const result = await host.runTool(
        "send_message_to_user_async",
        { message: "  Synthetic attention\u001b[2J  " },
        { ctx },
      );

      expect(result.content).toEqual([{ type: "text", text: "Shown to the user." }]);
      expect(host.getNotifications()).toEqual(
        mode === "tui" ? [] : [{ message: "Synthetic attention", type: "info" }],
      );
      expect(host.getAppendedEntries()).toEqual([]);
      expect(host.getSentUserMessages()).toEqual([]);
      expect(host.getSentMessages()).toEqual([]);
    },
  );
  it("rejects empty messages without notifying", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createToolContext({ mode: "rpc" });
    await expect(
      host.runTool("send_message_to_user_async", { message: " \u0007 " }, { ctx }),
    ).rejects.toThrow("empty");
    expect(host.getNotifications()).toEqual([]);
  });
});
