import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createVoiceTrace } from "../trace.js";

describe("voice trace", () => {
  let directory: string | undefined;
  let originalTraceDirectory: string | undefined;

  beforeEach(() => {
    originalTraceDirectory = process.env.PI_VOICE_TRACE_DIR;
  });

  afterEach(() => {
    if (originalTraceDirectory === undefined) {
      delete process.env.PI_VOICE_TRACE_DIR;
    } else {
      process.env.PI_VOICE_TRACE_DIR = originalTraceDirectory;
    }
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("records private ordered NDJSON when explicitly enabled", () => {
    directory = mkdtempSync(path.join(tmpdir(), "pi-voice-trace-"));
    process.env.PI_VOICE_TRACE_DIR = directory;

    const trace = createVoiceTrace();
    trace?.("test", { value: 1 });

    const file = path.join(directory, "voice.ndjson");
    expect(statSync(file).mode % 0o1000).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({
      detail: { value: 1 },
      kind: "test",
      sequence: 1,
    });
  });
});
