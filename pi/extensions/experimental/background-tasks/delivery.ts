import type { MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Batch, Inbox } from "./inbox.js";

export const CHECKPOINT = "background-tasks:attention";
export const WAKE_TYPE = "background-tasks:wake";
export const WAKE_BUDGET = 8;
export const CHECKPOINT_VERSION = 2;
const checkpointSchema = Type.Object(
  {
    v: Type.Literal(CHECKPOINT_VERSION),
    sessionId: Type.String(),
    remaining: Type.Integer({ minimum: 0, maximum: WAKE_BUDGET }),
    held: Type.Boolean(),
  },
  { additionalProperties: false },
);
export interface DeliveryHooks {
  ready(): boolean;
  send(batch: Batch): void;
  checkpoint(remaining: number, held: boolean): void;
  changed(): void;
}

/** Attention accounting is session-wide, independent of process and branch state. */
export class Delivery {
  remaining = 0;
  held = true;
  error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private unsubscribeAbort?: () => void;
  private awaitingCycle = false;
  constructor(
    private inbox: Inbox,
    private hooks: DeliveryHooks,
  ) {}

  restore(entries: readonly SessionEntry[], sessionId: string): void {
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== CHECKPOINT) continue;
      if (Value.Check(checkpointSchema, entry.data) && entry.data.sessionId === sessionId) {
        this.remaining = entry.data.remaining;
        this.held = entry.data.held;
      }
    }
  }
  message(event: MessageEndEvent): void {
    const message = event.message;
    if (message.role === "assistant" && message.stopReason === "aborted") this.pause();
  }
  agentStart(signal?: AbortSignal): void {
    this.unsubscribeAbort?.();
    const abort = () => this.pause();
    signal?.addEventListener("abort", abort, { once: true });
    this.unsubscribeAbort = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) this.pause();
  }
  settled(): void {
    this.unsubscribeAbort?.();
    this.unsubscribeAbort = undefined;
    this.awaitingCycle = false;
    if (this.inbox.outstanding) this.pause();
    this.schedule();
  }
  acknowledge(id: string): void {
    if (this.inbox.acknowledge(id)) this.hooks.changed();
    // Wait for agent_settled before another automatic dispatch.
  }
  rearm(): void {
    if (this.closed) return;
    // Only retry after a settled, unobserved cycle. Never duplicate a queued message.
    if (!this.awaitingCycle) this.inbox.retry();
    this.remaining = WAKE_BUDGET;
    this.held = false;
    this.save();
    this.schedule();
  }
  pause(): void {
    if (this.closed) return;
    const needsSave = !this.held || this.error !== undefined;
    this.held = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (needsSave) this.save();
  }
  schedule(): void {
    if (
      this.closed ||
      this.held ||
      this.remaining === 0 ||
      this.timer ||
      this.awaitingCycle ||
      !this.inbox.count
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 100);
    this.timer.unref();
  }
  flush(): void {
    if (
      this.closed ||
      this.held ||
      this.remaining === 0 ||
      this.awaitingCycle ||
      !this.hooks.ready()
    )
      return;
    const batch = this.inbox.take();
    if (!batch) return;
    this.awaitingCycle = true;
    this.remaining--;
    if (!this.save()) {
      this.awaitingCycle = false;
      return;
    }
    try {
      this.hooks.send(batch);
    } catch {
      this.awaitingCycle = false;
      this.pause();
    }
  }
  private save(): boolean {
    try {
      this.hooks.checkpoint(this.remaining, this.held);
      this.error = undefined;
    } catch {
      // Never dispatch if attention accounting cannot be recorded.
      this.held = true;
      this.error = "Attention checkpoint could not be recorded; notifications held.";
      this.hooks.changed();
      return false;
    }
    this.hooks.changed();
    return true;
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.unsubscribeAbort?.();
  }
}
