import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const spawn = vi.hoisted(() => vi.fn());

vi.mock(import("node:child_process"), async (importOriginal) => ({
  ...(await importOriginal()),
  spawn,
}));

import { killProcessTree } from "../tools/process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  spawn.mockReset();
  if (platform !== undefined) {
    Object.defineProperty(process, "platform", platform);
  }
});

describe(killProcessTree, () => {
  it("uses trusted System32 taskkill and falls back for both spawn failures", () => {
    const taskkill = new EventEmitter();
    const child = { kill: vi.fn(), pid: 1234 };
    const systemRoot = process.env.SystemRoot;
    process.env.SystemRoot = "C:\\CustomWindows";
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    spawn.mockReturnValue(taskkill);

    try {
      killProcessTree(child);
    } finally {
      if (systemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = systemRoot;
      }
    }

    expect(spawn).toHaveBeenCalledWith(
      path.join("C:\\CustomWindows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", "1234"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    taskkill.emit("error", new Error("spawn taskkill ENOENT"));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.kill.mockClear();
    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(() => killProcessTree(child)).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
