import { describe, it, expect } from "vite-plus/test";
import { TaskLogs, LOG_BYTES } from "../logs.js";

describe("TaskLogs", () => {
  it("bounds stream tails in memory and reports omitted bytes", () => {
    const logs = new TaskLogs();
    logs.append("stdout", Buffer.alloc(LOG_BYTES * 4, 120));
    logs.append("stdout", Buffer.from("end"));
    logs.append("stderr", Buffer.from("diagnostic"));
    expect(logs.read(3)).toEqual({
      stdout: "end",
      stderr: "tic",
      stdoutOmittedBytes: LOG_BYTES * 4,
      stderrOmittedBytes: 7,
    });
    expect(logs.read(LOG_BYTES).stdout).toBe("x".repeat(LOG_BYTES - 3) + "end");
  });
  it("removes terminal controls from reads", () => {
    const logs = new TaskLogs();
    logs.append("stderr", Buffer.from("diagnostic\u001b[2J\n"));
    expect(logs.read().stderr).toBe("diagnostic\n");
  });
});
