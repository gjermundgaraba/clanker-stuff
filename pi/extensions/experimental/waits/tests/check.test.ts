import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCondition } from "../check.js";

// Why: the killed sleep is an orphan, and it stays a zombie that
// kill(pid, 0) still finds until PID 1 reaps it, which can lag under load.
const stillRunning = (pid: number): boolean => {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();

  return stat !== "" && !stat.startsWith("Z");
};

const run = async (command: string, timeoutMs = 5000, cwd = "/") =>
  await runCondition({ command, cwd, timeoutMs }, new AbortController().signal);

describe("runCondition", () => {
  it("reports the condition's exit code", async () => {
    await expect(run("exit 0")).resolves.toBe(0);
    await expect(run("exit 3")).resolves.toBe(3);
  });

  it("runs in the given directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "waits-check-"));

    try {
      await expect(
        run(
          `test "$(pwd -P)" = "$(cd ${JSON.stringify(directory)} && pwd -P)"`,
          5000,
          directory
        )
      ).resolves.toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills the whole process group on timeout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "waits-check-"));
    const pidFile = path.join(directory, "pid");

    try {
      await expect(
        run(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`, 300)
      ).resolves.toBe("timeout");

      const pid = Number(await readFile(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      await expect.poll(() => stillRunning(pid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects when aborted", async () => {
    const controller = new AbortController();

    const pending = runCondition(
      { command: "sleep 30", cwd: "/", timeoutMs: 60_000 },
      controller.signal
    );

    controller.abort();

    await expect(pending).rejects.toThrow(/killed/u);
  });

  it("rejects when the shell cannot start", async () => {
    await expect(run("exit 0", 5000, "/does/not/exist")).rejects.toThrow(
      /ENOENT/u
    );
  });
});
