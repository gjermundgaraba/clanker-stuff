import type { PresenceRecord } from "./record.ts";

export type Word = "working" | "waiting" | "stopped";

export interface Verdict {
  readonly word: Word;
  readonly detail: string;
}

const ago = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 90) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

const doing = (record: PresenceRecord): string =>
  record.tool === undefined ? "a model turn" : `the ${record.tool} tool`;

/**
 * What one session is doing, for the person running it. A session that is
 * gone is stopped. A dialog is waiting on you. A running agent is working,
 * and so is an idle one that has parked work elsewhere: a wait, or a
 * question to another session. Any other idle session is waiting on you.
 */
export const verdictOf = (
  record: PresenceRecord,
  alive: boolean,
  now: number
): Verdict => {
  if (record.endedAt !== undefined) {
    return { word: "stopped", detail: `quit ${ago(now - record.endedAt)}` };
  }

  if (!alive) {
    return {
      word: "stopped",
      detail: `died during ${record.activity === "idle" ? "an idle spell" : doing(record)}, last seen ${ago(now - record.updatedAt)}`,
    };
  }

  if (record.activity === "dialog") {
    return {
      word: "waiting",
      detail: `on you: a dialog is open, since ${ago(now - record.since)}`,
    };
  }

  if (record.activity === "busy") {
    return {
      word: "working",
      detail: `in ${doing(record)}, since ${ago(now - record.since)}`,
    };
  }

  if (record.parked.length > 0) {
    return {
      word: "working",
      detail: `parked on ${record.parked.map((item) => item.about).join("; ")}`,
    };
  }

  return {
    word: "waiting",
    detail: `on you: idle since ${ago(now - record.since)}`,
  };
};
