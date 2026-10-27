import { safeText } from "@clanker-stuff/pi-tool-rendering/text";

import type { LogSummary } from "./output.js";

export const LOG_BYTES = 128 * 1024;

export const DEFAULT_TAIL_BYTES = 6000;

/** Bounded in-memory tail of each output stream. */
export class TaskLogs {
  private readonly tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  private readonly received = { stdout: 0, stderr: 0 };

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    this.received[stream] += chunk.length;
    this.tails[stream] = Buffer.concat([
      this.tails[stream],
      chunk.subarray(-LOG_BYTES),
    ]).subarray(-LOG_BYTES);
  }
  read(bytes = DEFAULT_TAIL_BYTES): LogSummary {
    return {
      stdout: safeText(this.tails.stdout.subarray(-bytes).toString("utf-8")),
      stderr: safeText(this.tails.stderr.subarray(-bytes).toString("utf-8")),
      stdoutOmittedBytes: Math.max(0, this.received.stdout - bytes),
      stderrOmittedBytes: Math.max(0, this.received.stderr - bytes),
    };
  }
}
