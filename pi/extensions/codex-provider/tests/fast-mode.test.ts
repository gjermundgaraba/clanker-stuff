import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { SPIKE_MODEL } from "./fixtures.js";

const FAST_MODEL = { ...SPIKE_MODEL, id: "gpt-5.5", name: "GPT-5.5" };

describe("Codex fast mode", () => {
  it("starts from the flag and toggles only supported-model status", async () => {
    const host = createExtensionHost(
      (pi) => {
        Object.assign(pi, {
          registerEntryRenderer: vi.fn<() => void>(),
          registerProvider: vi.fn<() => void>(),
        });
        extension(pi);
      },
      { flags: { fast: true }, model: FAST_MODEL }
    );
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    expect(host.getStatus("codex-fast")).toBe("⚡");

    await host.runCommand("fast", "", ctx);
    await host.runCommand(
      "fast",
      "",
      host.createContext({ model: SPIKE_MODEL })
    );

    expect(host.getStatus("codex-fast")).toBeUndefined();
    expect(host.getNotifications().map(({ message }) => message)).toStrictEqual(
      ["Codex fast mode disabled", "Codex fast mode enabled"]
    );
  });
});
