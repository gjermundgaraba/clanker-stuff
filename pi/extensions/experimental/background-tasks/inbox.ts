import { randomUUID } from "node:crypto";

export interface Observation {
  id: string;
  taskId: string;
  seq: number;
  terminal: boolean;
  reason: string;
  key?: string;
  data?: unknown;
}
export interface Batch {
  id: string;
  events: Observation[];
}
export interface InboxLimits {
  progress: number;
  bytes: number;
  terminals: number;
  history: number;
}
const defaults: InboxLimits = { progress: 64, bytes: 64 * 1024, terminals: 32, history: 64 };

/** Reservations make terminal retention bounded without losing admitted results. */
export class Inbox {
  private reservations = new Set<string>();
  private pending: Observation[] = [];
  private history: Observation[] = [];
  private flight?: Batch;
  private sequence = 0;
  omitted = 0;
  evicted = 0;
  constructor(private limits: InboxLimits = defaults) {}

  reserve(id: string): void {
    if (this.reservations.size >= this.limits.terminals)
      throw new Error(
        "Terminal inbox full; wait for pending notifications to be delivered before starting more.",
      );
    this.reservations.add(id);
  }
  private release(id: string): void {
    this.reservations.delete(id);
  }
  protected(id: string): boolean {
    // The supervisor emits terminal last; FIFO acknowledgement cannot release
    // its reservation while earlier task events remain pending or in flight.
    return this.reservations.has(id);
  }
  add(input: Omit<Observation, "id" | "seq">): Observation {
    const { taskId, terminal, key } = input;
    const event: Observation = {
      ...input,
      id: `e_${randomUUID()}`,
      seq: ++this.sequence,
    };
    if (terminal && !this.reservations.has(taskId))
      throw new Error("Terminal outcome has no reservation");
    if (!terminal && key !== undefined) {
      this.pending = this.pending.filter((e) => e.terminal || e.taskId !== taskId || e.key !== key);
    }
    this.pending.push(event);
    while (
      this.progressCount() > this.limits.progress ||
      this.progressBytes() > this.limits.bytes
    ) {
      const oldest = this.pending.findIndex((e) => !e.terminal);
      if (oldest < 0) break;
      this.pending.splice(oldest, 1);
      this.omitted++;
    }
    return event;
  }
  private progressCount(): number {
    return this.pending.filter((e) => !e.terminal).length;
  }
  private progressBytes(): number {
    return this.pending.reduce(
      (n, e) => n + (e.terminal ? 0 : Buffer.byteLength(JSON.stringify(e))),
      0,
    );
  }
  take(): Batch | undefined {
    if (this.flight || !this.pending.length) return undefined;
    // Only IDs and reasons are pushed; payload sizes do not enlarge notifications.
    this.flight = { id: `b_${randomUUID()}`, events: this.pending.splice(0, 8) };
    return this.flight;
  }
  acknowledge(id: string): boolean {
    if (this.flight?.id !== id) return false;
    for (const event of this.flight.events) {
      if (event.terminal) this.release(event.taskId);
      this.history.push(event);
    }
    this.flight = undefined;
    while (this.history.length > this.limits.history) {
      this.history.shift();
      this.evicted++;
    }
    return true;
  }
  retry(): void {
    if (!this.flight) return;
    this.pending.unshift(...this.flight.events);
    this.flight = undefined;
    // The bounded in-flight batch is extra reserved capacity; never coalesce it away.
  }
  abandon(taskId: string): void {
    this.release(taskId);
    this.pending = this.pending.filter((e) => e.taskId !== taskId);
    if (this.flight) this.flight.events = this.flight.events.filter((e) => e.taskId !== taskId);
  }
  lookup(taskId: string, id?: string): Observation[] {
    return [...this.history, ...(this.flight?.events ?? []), ...this.pending].filter(
      (e) => e.taskId === taskId && (id === undefined || e.id === id),
    );
  }
  get outstanding(): string | undefined {
    return this.flight?.id;
  }
  get count(): number {
    return this.pending.length + (this.flight?.events.length ?? 0);
  }
  clear(): void {
    this.pending = [];
    this.history = [];
    this.flight = undefined;
    this.reservations.clear();
  }
}
