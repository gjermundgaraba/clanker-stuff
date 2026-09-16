import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { TaskLogs, LOG_BYTES } from "../logs.js";

describe("TaskLogs", () => {
  it("bounds stream tails in memory and on disk and reports omitted bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-log-test-"));
    const logs = new TaskLogs(directory);
    try {
      logs.append("stdout", Buffer.alloc(LOG_BYTES * 4, 120));
      logs.append("stdout", Buffer.from("end"));
      logs.append("stderr", Buffer.from("diagnostic"));
      await logs.close();
      expect((await readFile(join(directory, "stdout.log"))).length).toBe(LOG_BYTES);
      expect((await stat(join(directory, "stdout.log"))).mode & 0o777).toBe(0o600);
      expect(logs.read(3)).toMatchObject({
        stdout: "end",
        stderr: "tic",
        stdoutOmittedBytes: LOG_BYTES * 4,
      });
      logs.append("stdout", Buffer.from("ignored"));
      expect(logs.read(3).stdout).toBe("end");
    } finally {
      await logs.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("contains write failures without losing the memory tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task-log-test-"));
    await rm(directory, { recursive: true });
    const logs = new TaskLogs(directory);
    logs.append("stdout", Buffer.from("retained"));
    await logs.close();
    expect(logs.read().stdout).toBe("retained");
    expect(logs.error).toMatch(/ENOENT/);
  });
});
