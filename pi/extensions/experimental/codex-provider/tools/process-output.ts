import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

export interface OutputSnapshot {
  content: string;
  fullOutputPath?: string;
  truncation: TruncationResult;
}

export class ProcessOutput {
  private closed = false;
  private completedLines = 0;
  private readonly decoder = new TextDecoder();
  private hasOpenLine = false;
  private readonly stream: WriteStream;
  private tail = "";
  private totalBytes = 0;
  private readonly tempFilePath = path.join(
    tmpdir(),
    `pi-process-${randomBytes(8).toString("hex")}.log`,
  );

  constructor() {
    this.stream = createWriteStream(this.tempFilePath);
    this.stream.on("error", () => {
      // finished() reports the error to the caller.
    });
  }

  append(data: Buffer): void {
    if (this.closed) {
      return;
    }
    this.stream.write(data);
    this.appendText(this.decoder.decode(data, { stream: true }));
  }

  async discard(): Promise<void> {
    try {
      await this.finishStream();
    } finally {
      await rm(this.tempFilePath, { force: true });
    }
  }

  async snapshot(): Promise<OutputSnapshot> {
    await this.finishStream();
    const tailTruncation = truncateTail(this.tail);
    const totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
    const truncated = totalLines > DEFAULT_MAX_LINES || this.totalBytes > DEFAULT_MAX_BYTES;
    const truncation: TruncationResult = {
      ...tailTruncation,
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
      totalBytes: this.totalBytes,
      totalLines,
      truncated,
      truncatedBy: truncated
        ? (tailTruncation.truncatedBy ?? (this.totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
        : null,
    };
    if (!truncated) {
      await rm(this.tempFilePath, { force: true });
    }
    return {
      content: truncation.content,
      fullOutputPath: truncated ? this.tempFilePath : undefined,
      truncation,
    };
  }

  private appendText(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.totalBytes += Buffer.byteLength(text);
    this.tail += text;

    let newlines = 0;
    let lastNewline = -1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      newlines += 1;
      lastNewline = index;
    }
    if (newlines === 0) {
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      this.hasOpenLine = text.slice(lastNewline + 1).length > 0;
    }

    if (Buffer.byteLength(this.tail) > DEFAULT_MAX_BYTES * 4) {
      const endsWithNewline = this.tail.endsWith("\n");
      this.tail = truncateTail(this.tail, {
        maxBytes: DEFAULT_MAX_BYTES * 2,
        maxLines: DEFAULT_MAX_LINES * 2,
      }).content;
      if (endsWithNewline) {
        this.tail += "\n";
      }
    }
  }

  private async finishStream(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.appendText(this.decoder.decode());
    const done = finished(this.stream);
    this.stream.end();
    await done;
  }
}
