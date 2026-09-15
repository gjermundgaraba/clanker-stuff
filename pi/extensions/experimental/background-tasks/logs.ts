import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const LOG_BYTES = 128 * 1024;
export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(
    // Strip terminal control bytes intentionally, in addition to ANSI sequences.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    "",
  );
}

/** Bounded tail in RAM and on disk. At most one snapshot write per stream is pending. */
export class TaskLogs {
  private stdout = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private received = { stdout: 0, stderr: 0 };
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private closed = false;
  error?: string;
  constructor(readonly directory: string) {}

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (this.closed) return;
    this.received[stream] += chunk.length;
    this[stream] = Buffer.concat([this[stream], chunk.subarray(-LOG_BYTES)]).subarray(-LOG_BYTES);
    this.dirty = true;
    this.schedule();
  }
  private schedule(): void {
    if (this.timer || this.writing || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 100);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.dirty) return;
    this.dirty = false;
    const snapshots = { stdout: this.stdout, stderr: this.stderr };
    this.writing = Promise.all(
      (["stdout", "stderr"] as const).map((stream) => {
        const file = join(this.directory, `${stream}.log`);
        return withFileMutationQueue(file, () =>
          writeFile(file, snapshots[stream], { mode: 0o600 }),
        );
      }),
    )
      .then(() => {
        this.error = undefined;
      })
      .catch((error) => {
        this.error = safeText(String(error)).slice(0, 500);
      })
      .finally(() => {
        this.writing = undefined;
        if (this.dirty) this.schedule();
      });
    return this.writing;
  }
  read(bytes = 6000) {
    const size = Math.max(1, Math.min(12000, bytes));
    return {
      stdout: safeText(this.stdout.subarray(-size).toString("utf8")),
      stderr: safeText(this.stderr.subarray(-size).toString("utf8")),
      stdoutOmittedBytes: Math.max(0, this.received.stdout - size),
      stderrOmittedBytes: Math.max(0, this.received.stderr - size),
      directory: this.directory,
      storageError: this.error,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.writing;
    await this.flush();
  }
}
