import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { Outcome, TaskEvent } from "./output.js";

export const EVENT_RECORDS = 64;

/** Retained events as rendered in tool text, so they fit task_inspect's preview ahead of logs. */
export const EVENT_BYTES = 16 * 1024;

export interface Unread {
  events: number;
  outcome?: Outcome;
}

/** One task's retained watcher events, and how much of the task its notices have announced. */
export class TaskNotices {
  private retained: { event: TaskEvent; bytes: number }[] = [];
  private last = 0;
  private noticed = 0;
  /** Unannounced events retention dropped; they still count as news. */
  private droppedUnread = 0;
  private outcomeNoticed = false;
  omitted = 0;

  get events(): TaskEvent[] {
    return this.retained.map(({ event }) => event);
  }

  record(data: JsonValue, key?: string): void {
    // A key replaces its own unannounced snapshot; announced events stay inspectable.
    if (key !== undefined)
      this.retained = this.retained.filter(
        ({ event }) => event.key !== key || event.seq <= this.noticed,
      );
    const event = { seq: ++this.last, ...(key === undefined ? {} : { key }), data };
    this.retained.push({ event, bytes: Buffer.byteLength(jsonText(event)) });

    // The newest event stays even when it alone passes the byte cap, as a maximal record does.
    while (
      this.retained.length > 1 &&
      (this.retained.length > EVENT_RECORDS ||
        this.retained.reduce((total, { bytes }) => total + bytes, 0) > EVENT_BYTES)
    ) {
      const dropped = this.retained.shift();

      if (dropped !== undefined && dropped.event.seq > this.noticed) this.droppedUnread++;
      this.omitted++;
    }
  }

  /** Pass the task's outcome once it may be announced, after process cleanup. */
  unread(outcome: Outcome | undefined): Unread | undefined {
    const events =
      this.droppedUnread + this.retained.filter(({ event }) => event.seq > this.noticed).length;

    const announce = outcome !== undefined && !this.outcomeNoticed;

    if (!events && !announce) return undefined;

    return { events, ...(announce ? { outcome } : {}) };
  }

  /** Marks every captured event, and the outcome when included, as announced or read. */
  clear(outcome: boolean): void {
    this.noticed = this.last;
    this.droppedUnread = 0;

    if (outcome) this.outcomeNoticed = true;
  }
}
