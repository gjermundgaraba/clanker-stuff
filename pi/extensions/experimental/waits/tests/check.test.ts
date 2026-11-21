import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCondition } from "../check.js";

const run = async (command: string, timeoutMs = 5000, cwd = "/") =>
  await runCondition({ command, cwd, timeoutMs }, new AbortController().signal);

describe("runCondition", () => {
  it("reports the condition's exit code", async () => {
    await expect(run("exit 0")).resolves.toStrictEqual({
      exitCode: 0,
      timedOut: false,
    });
    await expect(run("exit 3")).resolves.toStrictEqual({
      exitCode: 3,
      timedOut: false,
    });
  });

  it("runs in the given directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "waits-check-"));

    try {
      await expect(
        run('test "$(pwd -P)" = "$(cd "$0" && pwd -P)"', 5000, directory)
      ).resolves.toMatchObject({ exitCode: 1 });
      await expect(
        run(
          `test "$(pwd -P)" = "$(cd ${JSON.stringify(directory)} && pwd -P)"`,
          5000,
          directory
        )
      ).resolves.toMatchObject({ exitCode: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills the whole process group on timeout and reports no exit code", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "waits-check-"));
    const pidFile = path.join(directory, "pid");

    try {
      const outcome = await run(
        `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        300
      );

      expect(outcome).toStrictEqual({ exitCode: null, timedOut: true });

      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("kills the group when aborted", async () => {
    const controller = new AbortController();

    const pending = runCondition(
      { command: "sleep 30", cwd: "/", timeoutMs: 60_000 },
      controller.signal
    );

    controller.abort();

    await expect(pending).resolves.toStrictEqual({
      exitCode: null,
      timedOut: false,
    });
  });

  it("reports no exit code when the shell cannot start", async () => {
    await expect(run("exit 0", 5000, "/does/not/exist")).resolves.toStrictEqual(
      { exitCode: null, timedOut: false }
    );
  });
});
