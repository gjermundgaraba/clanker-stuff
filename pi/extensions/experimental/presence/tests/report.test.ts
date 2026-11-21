import { rm } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../tests/helpers/fs.js";
import { readRecords, writeRecord } from "../record.js";
import type { PresenceRecord } from "../record.js";
import { renderTable } from "../report.js";

const NOW = 10_000_000;

const record = (
  pid: number,
  patch: Partial<PresenceRecord>
): PresenceRecord => ({
  pid,
  sessionId: `s${pid}`,
  cwd: "/work",
  startedAt: NOW,
  updatedAt: NOW,
  activity: "idle",
  since: NOW,
  parked: [],
  ...patch,
});

describe("the presence table", () => {
  it("puts sessions waiting on you first and names unnamed ones by session ID", () => {
    const table = renderTable(
      [
        record(1, { name: "orca", activity: "busy" }),
        record(2, { name: "kiwi", activity: "busy" }),
        record(3, { name: "lark" }),
        record(4, {}),
      ],
      (pid) => pid !== 1,
      NOW
    );

    expect(
      table.split("\n").map((line) => line.split(/\s+/u).slice(0, 4))
    ).toStrictEqual([
      ["lark", "waiting", "pid", "3"],
      ["s4", "waiting", "pid", "4"],
      ["kiwi", "working", "pid", "2"],
      ["orca", "stopped", "pid", "1"],
    ]);
  });

  it("reads back a record with parked work", async () => {
    const dir = await createTempDir("presence-record-");

    try {
      const parked = record(7, {
        name: "moth",
        parked: [{ source: "waits", id: "w_1", about: "a wait for the build" }],
      });

      await writeRecord(dir, parked);

      await expect(readRecords(dir)).resolves.toStrictEqual([parked]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says so when no session has reported", () => {
    expect(renderTable([], () => true, NOW)).toBe(
      "No Pi sessions have reported their presence."
    );
  });
});
