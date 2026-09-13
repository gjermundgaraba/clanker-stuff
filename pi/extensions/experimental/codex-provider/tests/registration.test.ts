import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { registerCodexProvider } from "../registration.js";
import { SPIKE_MODEL } from "./fixtures.js";

const OTHER_MODEL = {
  ...SPIKE_MODEL,
  api: "anthropic-messages",
  id: "claude-test",
  name: "Claude Test",
  provider: "anthropic",
} satisfies Model<"anthropic-messages">;

describe("Provider-only registration", () => {
  it("registers the provider without activating provider tools", async () => {
    const host = createExtensionHost(registerCodexProvider, { model: OTHER_MODEL });
    await host.ready;
    expect(host.getRegisteredNativeProviders().has("openai-codex")).toBe(true);
    expect(host.getRegisteredCommands().has("codex-provider")).toBe(true);
    expect(host.getRegisteredCommands().has("code-mode")).toBe(false);
    expect(host.getRegisteredTools().size).toBe(0);
    const active = host.getActiveTools();
    await host.emitSessionStart();
    await host.emit("input", { type: "input", text: "task", source: "interactive" });
    await host.emit("model_select", {
      type: "model_select",
      model: SPIKE_MODEL,
      previousModel: OTHER_MODEL,
      source: "set",
    });
    expect(host.getActiveTools()).toStrictEqual(active);
    expect(host.getRegisteredTools().size).toBe(0);
    await host.emit("session_shutdown", { type: "session_shutdown", reason: "exit" });
  });
});
