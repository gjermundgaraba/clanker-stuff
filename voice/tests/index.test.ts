import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

describe("voice extension", () => {
  it("registers the command, shortcut, and voice tools", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    expect(host.getRegisteredCommands().has("voice")).toBeTruthy();
    expect(host.getRegisteredTools().has("speak_to_user")).toBeTruthy();
    expect(host.getRegisteredTools().has("present_voice_result")).toBeTruthy();
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

  it("keeps a visual result available when no voice handoff is active", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("present_voice_result", {
      markdown: "# Detailed result",
      spokenSummary: "The detailed result is in the terminal.",
    });

    expect(result).toMatchObject({
      content: [{ text: "No active voice conversation was available." }],
      details: { delivered: false, markdown: "# Detailed result" },
      terminate: false,
    });
  });

  it("documents clear sign-offs as voice-ending intent", async () => {
    const host = createExtensionHost(extension);
    await host.ready;

    const tool = host
      .getRegisteredTools()
      .get("end_realtime_voice_call")?.definition;
    expect(tool?.description).toContain("clearly signs off");
  });

  it("starts with no footer status", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);

    expect(host.getStatus("voice")).toBeUndefined();
  });
});
