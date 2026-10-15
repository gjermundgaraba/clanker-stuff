import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../../tests/helpers/fs.js";
import { verifyWrittenSession } from "../../session/verify.js";

const SID = "abc-123";

const record = (sessionId: string, index: number): string => JSON.stringify({ sessionId, index });

const jsonl = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("verifyWrittenSession", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await createTempDir("claude-bridge-verify-");
    file = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports nothing when the file round-trips", async () => {
    await writeFile(file, jsonl(record(SID, 0), record(SID, 1), record(SID, 2)));

    expect(verifyWrittenSession(file, SID, 3)).toEqual([]);
  });

  it("warns when the file is missing", () => {
    expect(verifyWrittenSession(path.join(dir, "nope.jsonl"), SID, 0)).toEqual([
      expect.stringMatching(/^file missing after save/),
    ]);
  });

  it("warns on a record count mismatch", async () => {
    await writeFile(file, jsonl(record(SID, 0), record(SID, 1)));

    expect(verifyWrittenSession(file, SID, 5)).toEqual([
      expect.stringMatching(/^record count mismatch: expected=5 actual=2 /),
    ]);
  });

  it("warns on sessionId drift", async () => {
    await writeFile(file, jsonl(record(SID, 0), record("different-sid", 1)));

    expect(verifyWrittenSession(file, SID, 2)).toEqual([
      `sessionId drift: expected=${SID} first=${SID} last=different-sid`,
    ]);
  });

  it("warns on malformed JSONL", async () => {
    await writeFile(file, "not json\n");

    expect(verifyWrittenSession(file, SID, 1)).toEqual([expect.stringMatching(/^malformed JSONL/)]);
  });
});
