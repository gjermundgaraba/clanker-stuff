import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const fastMode = vi.hoisted(() => ({
  applyToRequest: vi.fn<
    (
      payload: unknown,
      ctx: ExtensionContext
    ) => { service_tier: string } | undefined
  >(() => ({ service_tier: "priority" })),
  refreshStatus: vi.fn<(ctx: ExtensionContext) => void>(),
  start: vi.fn<(enabled: boolean, ctx: ExtensionContext) => void>(),
  toggle: vi.fn<(ctx: ExtensionContext) => void>(),
}));

vi.mock(import("../fast-mode.js"), () => ({
  createFastMode: () => fastMode,
}));

describe("codex-fast registration", () => {
  it("registers and delegates the fast-mode lifecycle", async () => {
    const host = createExtensionHost(extension, { flags: { fast: true } });
    const ctx = host.createContext();
    const event = {
      payload: { stream: true },
      type: "before_provider_request",
    };

    await host.emitSessionStart(ctx);
    await host.runCommand("fast", "", ctx);
    const result = await host.emit("before_provider_request", event, ctx);
    await host.emit("model_select", {}, ctx);

    expect(host.getRegisteredCommands().get("fast")?.description).toBe(
      "Toggle OpenAI Codex fast mode"
    );
    expect(result).toStrictEqual([{ service_tier: "priority" }]);
    expect({
      applyToRequest: fastMode.applyToRequest.mock.calls,
      refreshStatus: fastMode.refreshStatus.mock.calls,
      start: fastMode.start.mock.calls,
      toggle: fastMode.toggle.mock.calls,
    }).toStrictEqual({
      applyToRequest: [[event.payload, ctx]],
      refreshStatus: [[ctx]],
      start: [[true, ctx]],
      toggle: [[ctx]],
    });
  });
});
