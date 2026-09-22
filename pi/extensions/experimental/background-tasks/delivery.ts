import type { Batch, Inbox } from "./inbox.js";

export const WAKE_TYPE = "background-tasks:wake";

type Admission = "idle" | "before_settle";

export interface DeliveryHooks {
  ready(phase: Admission): boolean;
  send(batch: Batch): void;
  changed(): void;
}

/** One admission per activity, independently of the inbox's outstanding receipt. */
export class Delivery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private activityAdmission: Admission | undefined;
  constructor(
    private inbox: Inbox,
    private hooks: DeliveryHooks,
  ) {}

  /** Call after reconciling receipts against the actual session branch. */
  settled(): void {
    const retry = this.activityAdmission === "before_settle" && Boolean(this.inbox.outstanding);

    // A boundary proposal is finished at settlement: it was committed or dropped.
    // Settlement does not establish that a queued sendMessage was discarded.
    if (retry) this.inbox.retry();
    this.activityAdmission = undefined;
    this.schedule(retry ? 1000 : 100);
  }
  acknowledge(id: string): void {
    if (this.inbox.acknowledge(id)) this.hooks.changed();
    // Recording a receipt does not replenish this activity's admission allowance.
  }
  schedule(delayMs = 100): void {
    if (
      this.closed ||
      this.timer ||
      this.activityAdmission ||
      this.inbox.outstanding ||
      !this.inbox.count
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delayMs);
    this.timer.unref();
  }
  beforeSettle(): Batch | undefined {
    return this.admit("before_settle");
  }
  private admit(phase: Admission): Batch | undefined {
    if (this.closed || this.activityAdmission) return;

    if (!this.hooks.ready(phase)) {
      // Manual compaction can become idle without an agent_settled event.
      this.schedule(1000);

      return;
    }

    const batch = this.inbox.take();

    if (!batch) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.activityAdmission = phase;

    return batch;
  }
  flush(): void {
    const batch = this.admit("idle");

    if (!batch) return;

    try {
      // Readiness and handoff stay synchronous: Pi starts an idle prompt directly.
      this.hooks.send(batch);
    } catch {
      this.activityAdmission = undefined;
      this.inbox.retry();
      this.schedule(1000);
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
