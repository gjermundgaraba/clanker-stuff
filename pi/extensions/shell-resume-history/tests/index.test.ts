import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import type { recordResumeCommand as RecordResumeCommand } from "../resume-command.js";

const recordResumeCommand = vi.hoisted(() =>
  vi.fn<typeof RecordResumeCommand>(() => Promise.resolve())
);

vi.mock(import("../resume-command.js"), () => ({ recordResumeCommand }));

describe("shell-resume-history registration", () => {
  it("delegates session shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emitSessionShutdown(ctx);

    expect(recordResumeCommand).toHaveBeenCalledExactlyOnceWith("quit", ctx);
  });
});
