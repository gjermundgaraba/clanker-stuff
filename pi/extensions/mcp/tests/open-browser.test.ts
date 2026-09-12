import { syncBuiltinESMExports } from "node:module";
import childProcess, { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openBrowser } from "../open-browser.js";

describe(openBrowser, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });
  it.each([
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler"]],
  ] as const)("launches without a shell on %s", (platform, command, prefix) => {
    const originalPlatform = process.platform;
    const child = new ChildProcess();
    const unref = vi.spyOn(child, "unref");
    const spawn = vi.spyOn(childProcess, "spawn").mockReturnValue(child);
    syncBuiltinESMExports();
    const url = "https://example.com/authorize?state=a&scope=b|c^d";
    try {
      Object.defineProperty(process, "platform", { value: platform });
      openBrowser(url);

      expect(spawn).toHaveBeenCalledExactlyOnceWith(command, [...prefix, url], {
        stdio: "ignore",
        detached: true,
      });
      expect(unref).toHaveBeenCalledOnce();
      expect(() => child.emit("error", new Error("Launcher unavailable"))).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
