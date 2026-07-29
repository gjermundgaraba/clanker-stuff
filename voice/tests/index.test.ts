import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

describe("voice extension", () => {
  it("registers the command, shortcut, and speech tool", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    expect(host.getRegisteredCommands().has("voice")).toBeTruthy();
    expect(host.getRegisteredTools().has("speak_to_user")).toBeTruthy();
    expect(
      host.getRegisteredTools().has("end_realtime_voice_call")
    ).toBeTruthy();
    await expect(
      host.runShortcut("ctrl+shift+v", host.createContext({ mode: "json" }))
    ).rejects.toThrow("interactive TUI");
  });

  it("reports unavailable speech without an active call", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("speak_to_user", {
      message: "The tests need your approval.",
    });

    expect(result).toMatchObject({
      content: [{ text: "No active voice conversation was available." }],
      details: { delivered: false },
    });
  });

  it("reports unavailable voice ending without an active call", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("end_realtime_voice_call", {});

    expect(result).toMatchObject({
      content: [{ text: "No active realtime voice chat was available." }],
      details: { ended: false },
    });
  });

  it("starts with no footer status", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);

    expect(host.getStatus("voice")).toBeUndefined();
  });
});
