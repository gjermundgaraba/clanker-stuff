import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";

import type { Outcome, TaskEvent } from "./output.js";

export const EVENT_RECORDS = 64;

export const EVENT_BYTES = 16 * 1024;

export interface Unread {
  events: number;
  outcome?: Outcome;
}

export class TaskNotices {
  private retained: Array<{ event: TaskEvent; bytes: number }> = [];
  private last = 0;
  private noticed = 0;
  private droppedUnread = 0;
  private outcomeNoticed = false;
  omitted = 0;

  get events(): TaskEvent[] {
    return this.retained.map(({ event }) => event);
  }

  record(data: JsonValue, key?: string): void {
    if (key !== undefined) {
      this.retained = this.retained.filter(
        ({ event }) => event.key !== key || event.seq <= this.noticed
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
      const dropped = this.retained.shift();

      if (dropped !== undefined && dropped.event.seq > this.noticed) {
        this.droppedUnread += 1;
      }

      this.omitted += 1;
    }
  }

  unread(outcome: Outcome | undefined): Unread | undefined {
    const events =
      this.droppedUnread +
      this.retained.filter(({ event }) => event.seq > this.noticed).length;

    const announce = outcome !== undefined && !this.outcomeNoticed;

    if (!events && !announce) {
      return undefined;
    }

    return { events, ...(announce ? { outcome } : {}) };
  }

  clear(outcome: boolean): void {
    this.noticed = this.last;
    this.droppedUnread = 0;

    if (outcome) {
      this.outcomeNoticed = true;
    }
  }
}
