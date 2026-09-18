import type { Batch, Inbox } from "./inbox.js";

export const WAKE_TYPE = "background-tasks:wake";

export interface DeliveryHooks {
  ready(): boolean;
  send(batch: Batch): void;
  changed(): void;
}

/** Deliver automatically, with one batch in flight until Pi observes it and settles. */
export class Delivery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private awaitingCycle = false;
  constructor(
    private inbox: Inbox,
    private hooks: DeliveryHooks,
  ) {}

  settled(): void {
    this.awaitingCycle = false;
    // A queued notice may have been cleared by an abort. Retry after settling,
    // never while Pi could still consume the original follow-up.
    const unobserved = Boolean(this.inbox.outstanding);
    this.inbox.retry();
    this.schedule(unobserved ? 1000 : 100);
  }
  acknowledge(id: string): void {
    if (this.inbox.acknowledge(id)) this.hooks.changed();
    // Wait for agent_settled before another automatic dispatch.
  }
  schedule(delayMs = 100): void {
    if (this.closed || this.timer || this.awaitingCycle || !this.inbox.count) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delayMs);
    this.timer.unref();
  }
  flush(): void {
    if (this.closed || this.awaitingCycle) return;

    if (!this.hooks.ready()) {
      // Manual compaction can become idle without an agent_settled event.
      // Keep one readiness check pending, without handing off another batch.
      this.schedule(1000);

      return;
    }

    const batch = this.inbox.take();

    if (!batch) return;
    this.awaitingCycle = true;

    try {
      this.hooks.send(batch);
    } catch {
      this.awaitingCycle = false;
      this.inbox.retry();
      // A failed handoff must not require user intervention or spin synchronously.
      this.schedule(1000);
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
