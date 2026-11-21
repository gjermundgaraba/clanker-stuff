import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import { isAlive, presenceDir, readRecords } from "./record.ts";
import type { PresenceRecord } from "./record.ts";
import { verdictOf } from "./verdict.ts";
import type { Word } from "./verdict.ts";

const ORDER: readonly Word[] = ["waiting", "working", "stopped"];

const labelOf = (record: PresenceRecord): string =>
  inlineText(record.name ?? record.sessionId);

/**
 * One line per session: its name (or session ID when it has none), the word
 * for its state, its pid, and what it is doing. Sessions waiting on you come
 * first, then working ones, then stopped ones.
 */
export const renderTable = (
  records: readonly PresenceRecord[],
  alive: (pid: number) => boolean,
  now: number
): string => {
  if (records.length === 0) {
    return "No Pi sessions have reported their presence.";
  }

  const rows = records
    .map((record) => ({
      record,
      label: labelOf(record),
      verdict: verdictOf(record, alive(record.pid), now),
    }))
    .toSorted(
      (a, b) =>
        ORDER.indexOf(a.verdict.word) - ORDER.indexOf(b.verdict.word) ||
        a.label.localeCompare(b.label) ||
        b.record.updatedAt - a.record.updatedAt
    );

  const width = Math.max(...rows.map((row) => row.label.length));

  return rows
    .map(
      (row) =>
        `${row.label.padEnd(width)}  ${row.verdict.word.padEnd(7)}  pid ${String(row.record.pid).padEnd(6)}  ${inlineText(row.verdict.detail)}`
    )
    .join("\n");
};

/** The table for every record on disk, as of now. */
export const presenceTable = async (): Promise<string> =>
  renderTable(await readRecords(presenceDir()), isAlive, Date.now());
