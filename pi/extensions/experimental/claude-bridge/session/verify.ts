// Sanity check of a session file just written. Returns warnings rather than throwing:
// Claude Code may be more tolerant than these checks, so a false positive must not block
// the turn.

import { readFileSync, statSync } from "node:fs";

import { errorMessage } from "../log.js";

function recordSessionId(line: string | undefined): string | undefined {
  const value: unknown = line === undefined ? undefined : JSON.parse(line);

  return typeof value === "object" &&
    value !== null &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
    ? value.sessionId
    : undefined;
}

export function verifyWrittenSession(
  jsonlPath: string,
  expectedSessionId: string,
  expectedRecordCount: number,
): string[] {
  let size: number;

  try {
    size = statSync(jsonlPath).size;
  } catch (error) {
    return [`file missing after save: path=${jsonlPath} err=${errorMessage(error)}`];
  }

  let content: string;

  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch (error) {
    return [`file unreadable: path=${jsonlPath} size=${size} err=${errorMessage(error)}`];
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length !== expectedRecordCount) {
    return [
      `record count mismatch: expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`,
    ];
  }

  try {
    const first = recordSessionId(lines[0]);
    const last = recordSessionId(lines.at(-1));

    if (first !== expectedSessionId || last !== expectedSessionId) {
      return [`sessionId drift: expected=${expectedSessionId} first=${first} last=${last}`];
    }
  } catch (error) {
    return [`malformed JSONL: path=${jsonlPath} err=${errorMessage(error)}`];
  }

  return [];
}
