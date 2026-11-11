import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";

import type { Outcome, TaskEvent } from "./output.js";

export const EVENT_RECORDS = 64;

export const EVENT_BYTES = 16 * 1024;

export interface Unread {
  events: boolean;
  outcome?: Outcome;
}

/** Bounded task data, with independent inspection and wake-attempt watermarks. */
export class TaskNotices {
  private retained: Array<{ event: TaskEvent; bytes: number }> = [];
  private last = 0;
  private inspectedThrough = 0;
  private wakeThrough = 0;
  private outcomeInspected = false;
  private outcomeCovered = false;
  omitted = 0;

  get events(): TaskEvent[] {
    return this.retained.map(({ event }) => event);
  }

  record(data: JsonValue, key?: string): void {
    if (key !== undefined) {
      const covered = Math.max(this.inspectedThrough, this.wakeThrough);
      this.retained = this.retained.filter(
        ({ event }) => event.key !== key || event.seq <= covered
      );
    }

    this.last += 1;

    const event = {
      seq: this.last,
      ...(key === undefined ? {} : { key }),
      data,
    };

    this.retained.push({ event, bytes: Buffer.byteLength(jsonText(event)) });

    while (
      this.retained.length > 1 &&
      (this.retained.length > EVENT_RECORDS ||
        this.retained.reduce((total, { bytes }) => total + bytes, 0) >
          EVENT_BYTES)
    ) {
      this.retained.shift();
      this.omitted += 1;
    }
  }

  unread(outcome: Outcome | undefined): Unread | undefined {
    const events = this.last > this.inspectedThrough;
    const unseenOutcome = outcome !== undefined && !this.outcomeInspected;

    return events || unseenOutcome
      ? { events, ...(unseenOutcome ? { outcome } : {}) }
      : undefined;
  }

  /** Only updates neither inspected nor covered by an earlier wake need a new attempt. */
  wake(outcome: Outcome | undefined): Unread | undefined {
    const events =
      this.last > Math.max(this.inspectedThrough, this.wakeThrough);

    const unseenOutcome =
      outcome !== undefined && !this.outcomeInspected && !this.outcomeCovered;

    return events || unseenOutcome
      ? { events, ...(unseenOutcome ? { outcome } : {}) }
      : undefined;
  }

  /** Cover current updates on a wake attempt or Stop, without marking them inspected. */
  cover(outcome: boolean): void {
    this.wakeThrough = this.last;
    this.outcomeCovered ||= outcome;
  }

  clear(outcome: boolean): void {
    this.inspectedThrough = this.last;
    this.outcomeInspected ||= outcome;
  }
}
