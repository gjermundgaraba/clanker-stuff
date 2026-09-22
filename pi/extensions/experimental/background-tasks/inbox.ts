import type { JsonValue } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

export interface Observation {
  id: string;
  taskId: string;
  seq: number;
  terminal: boolean;
  reason: string;
  key?: string;
  data?: JsonValue;
}

export interface Batch {
  id: string;
  events: Observation[];
}

export interface InboxLimits {
  progress: number;
  bytes: number;
  protectedTasks: number;
  history: number;
}

const defaults: InboxLimits = { progress: 64, bytes: 64 * 1024, protectedTasks: 32, history: 64 };

/** Uncaptured outcomes and outstanding notices protect tasks against admission-time pruning. */
export class Inbox {
  private awaitingTerminalCapture = new Map<string, "unread" | "retrieved">();
  private pending: Observation[] = [];
  private history: Observation[] = [];
  private flight: Batch | undefined;
  private sequence = 0;
  omitted = 0;
  evicted = 0;
  constructor(private limits: InboxLimits = defaults) {}

  reserve(id: string): void {
    if (this.protectedTasks().size >= this.limits.protectedTasks)
      throw new Error(
        "Task notification capacity is full; inspect completed task summaries or allow cleanup and pending notifications to finish before starting more.",
      );
    this.awaitingTerminalCapture.set(id, "unread");
  }
  protected(id: string): boolean {
    return this.protectedTasks().has(id);
  }
  private protectedTasks(): Set<string> {
    const ids = new Set(this.awaitingTerminalCapture.keys());

    for (const event of [...this.pending, ...(this.flight?.events ?? [])]) ids.add(event.taskId);

    return ids;
  }
  /** Only capture grows storage; reads and receipts must not evict their payloads. */
  private trimHistory(): void {
    if (this.history.length <= this.limits.history) return;
    this.history.sort((a, b) => a.seq - b.seq);

    while (this.history.length > this.limits.history) {
      this.history.shift();
      this.evicted++;
    }
  }
  /** Retire retrieved notices, not their admitted batch's receipt or activity allowance. */
  consume(eventIds: readonly string[], terminalTaskId?: string): void {
    const ids = new Set(eventIds);

    // The immutable outcome can be returned before cleanup emits its terminal event.
    if (terminalTaskId !== undefined && this.awaitingTerminalCapture.has(terminalTaskId))
      this.awaitingTerminalCapture.set(terminalTaskId, "retrieved");
    const retired: Observation[] = [];

    const keep = (event: Observation): boolean => {
      if (!ids.has(event.id) && !(event.terminal && event.taskId === terminalTaskId)) return true;
      retired.push(event);

      return false;
    };

    this.pending = this.pending.filter(keep);

    if (this.flight) this.flight.events = this.flight.events.filter(keep);
    this.history.push(...retired);
  }
  add(input: Omit<Observation, "id" | "seq">): Observation {
    const { taskId, terminal, key } = input;

    const event: Observation = {
      ...input,
      id: `e_${randomUUID()}`,
      seq: ++this.sequence,
    };

    if (terminal) {
      const state = this.awaitingTerminalCapture.get(taskId);

      if (state === undefined) throw new Error("Terminal outcome has no reservation");
      this.awaitingTerminalCapture.delete(taskId);

      if (state === "retrieved") {
        this.history.push(event);
        this.trimHistory();

        return event;
      }
    }

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

    this.trimHistory();

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

    this.history.push(...this.flight.events);
    this.flight = undefined;

    return true;
  }
  retry(): void {
    if (!this.flight) return;
    this.pending.unshift(...this.flight.events);
    this.flight = undefined;
    // The bounded in-flight batch is extra reserved capacity; never coalesce it away.
  }
  abandon(taskId: string): void {
    this.awaitingTerminalCapture.delete(taskId);
    this.pending = this.pending.filter((e) => e.taskId !== taskId);

    if (this.flight) this.flight.events = this.flight.events.filter((e) => e.taskId !== taskId);
  }
  lookup(taskId: string, id?: string): Observation[] {
    return [...this.history, ...(this.flight?.events ?? []), ...this.pending]
      .filter((e) => e.taskId === taskId && (id === undefined || e.id === id))
      .sort((a, b) => a.seq - b.seq);
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
    this.awaitingTerminalCapture.clear();
  }
}
