import { randomBytes } from "node:crypto";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createActor } from "xstate";
import type { Actor } from "xstate";
import { restoreActor } from "xstate/persist";

import { WakeGate } from "./gate.js";
import { ownedWaits, waitEntry, WAIT_ENTRY } from "./journal.js";
import { phaseOf, waitMachine } from "./machine.js";
import type { WaitSpec } from "./machine.js";
import { rowOf, summaryOf, wakeText } from "./report.js";
import type { WaitSummary } from "./report.js";

export const WAKE_TYPE = "waits:wake";

const STATUS_KEY = "waits.open";

type WaitActor = Actor<typeof waitMachine>;

export interface OpenRequest {
  readonly label: string;
  readonly condition: string;
  readonly instruction: string;
  readonly cwd?: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly checkTimeoutSeconds?: number;
}

export const DEFAULTS = {
  intervalSeconds: 15,
  timeoutSeconds: 3600,
  checkTimeoutSeconds: 30,
} as const;

const isLive = (actor: WaitActor): boolean => {
  const phase = phaseOf(actor.getSnapshot());

  return phase === "open" || phase === "satisfied";
};

/**
 * Owns this session's wait actors. Every top-level phase change is journaled
 * as a session entry before anything acts on it; on session start the
 * journal is the only source, so reload, quit and relaunch, and a killed
 * process all restore the same way.
 */
export class WaitRuntime {
  private readonly pi: ExtensionAPI;
  private readonly waits = new Map<string, WaitActor>();
  private readonly stops: Array<() => void> = [];
  private ctx: ExtensionContext | undefined;
  private owner: string | undefined;
  private generation = 0;
  readonly gate = new WakeGate({
    context: () => this.ctx,
    hasWork: () => this.satisfied().length > 0,
    deliver: () => {
      this.deliver();
    },
  });

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  async startSession(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.owner = ctx.sessionManager.getSessionId();
    await this.restore(ctx.sessionManager.getBranch());
  }

  async tree(ctx: ExtensionContext): Promise<void> {
    this.stopAll();
    this.ctx = ctx;
    await this.restore(ctx.sessionManager.getBranch());
  }

  shutdown(): void {
    this.stopAll();
    this.gate.clear();

    if (this.ctx?.mode === "tui") {
      this.ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    this.ctx = undefined;
    this.owner = undefined;
  }

  open(request: OpenRequest, ctx: ExtensionContext): WaitSummary {
    if (ctx.mode === "print" || ctx.mode === "json") {
      throw new Error(
        "Waits need a live TUI or RPC session; print mode exits when its prompt ends."
      );
    }

    const spec: WaitSpec = {
      label: request.label,
      condition: request.condition,
      instruction: request.instruction,
      cwd: path.resolve(ctx.cwd, request.cwd ?? "."),
      intervalMs: (request.intervalSeconds ?? DEFAULTS.intervalSeconds) * 1000,
      timeoutMs: (request.timeoutSeconds ?? DEFAULTS.timeoutSeconds) * 1000,
      checkTimeoutMs:
        (request.checkTimeoutSeconds ?? DEFAULTS.checkTimeoutSeconds) * 1000,
    };

    const actor = createActor(waitMachine, {
      input: {
        id: `w_${randomBytes(4).toString("hex")}`,
        spec,
        openedAt: Date.now(),
      },
    });

    this.track(actor);
    this.journal(actor);

    return summaryOf(actor.getSnapshot());
  }

  list(): WaitSummary[] {
    return [...this.waits.values()].map((actor) =>
      summaryOf(actor.getSnapshot())
    );
  }

  cancel(id: string): WaitSummary {
    const actor = this.waits.get(id);

    if (!actor) {
      throw new Error(`No wait ${id} on this branch.`);
    }

    if (!isLive(actor)) {
      throw new Error(`Wait ${id} has already ended.`);
    }

    actor.send({ type: "wait.cancel" });

    return summaryOf(actor.getSnapshot());
  }

  rows(): string {
    const rows = this.list().map(rowOf);

    return rows.length ? rows.join("\n") : "No waits on this branch.";
  }

  /** A restore overtaken by a stop or a newer restore starts nothing. */
  private async restore(branch: readonly SessionEntry[]): Promise<void> {
    const { generation, owner } = this;

    if (owner === undefined) {
      return;
    }

    const snapshots = await ownedWaits(branch, owner);

    if (generation !== this.generation) {
      return;
    }

    for (const snapshot of snapshots) {
      this.track(restoreActor(waitMachine, snapshot));
    }

    this.showStatus();
    this.gate.request();
  }

  /** Starts an actor and journals each later change of its top-level phase. */
  private track(actor: WaitActor): void {
    let phase = phaseOf(actor.getSnapshot());

    const subscription = actor.subscribe((snapshot) => {
      const next = phaseOf(snapshot);

      if (next === phase) {
        return;
      }

      phase = next;
      this.journal(actor);
      this.showStatus();

      if (next === "satisfied") {
        this.gate.request();
      }
    });

    this.waits.set(actor.getSnapshot().context.id, actor);
    this.stops.push(() => {
      subscription.unsubscribe();
      actor.stop();
    });
    actor.start();
    this.showStatus();
  }

  private journal(actor: WaitActor): void {
    if (this.owner !== undefined) {
      this.pi.appendEntry(
        WAIT_ENTRY,
        waitEntry(
          this.owner,
          actor.getSnapshot().context.id,
          actor.getPersistedSnapshot()
        )
      );
    }
  }

  private satisfied(): WaitActor[] {
    return [...this.waits.values()].filter(
      (actor) => phaseOf(actor.getSnapshot()) === "satisfied"
    );
  }

  /**
   * Journals each satisfied wait as fired, then hands one wake to Pi. A
   * process that dies between the two loses the wake rather than repeating
   * it: at most once, because a repeated wake can act on a result twice.
   */
  private deliver(): void {
    const ready = this.satisfied().map((actor) => {
      actor.send({ type: "wait.delivered" });

      return actor.getSnapshot();
    });

    if (!ready.length) {
      return;
    }

    this.pi.sendMessage(
      {
        customType: WAKE_TYPE,
        content: wakeText(ready),
        display: true,
        details: { waits: ready.map(summaryOf) },
      },
      { triggerTurn: true }
    );
  }

  private stopAll(): void {
    this.generation += 1;

    for (const stop of this.stops.splice(0)) {
      stop();
    }

    this.waits.clear();
  }

  private showStatus(): void {
    const { ctx } = this;

    if (ctx?.mode !== "tui") {
      return;
    }

    const live = [...this.waits.values()].filter(isLive).length;

    ctx.ui.setStatus(
      STATUS_KEY,
      live ? ctx.ui.theme.fg("accent", `⏳ ${live}`) : undefined
    );
  }
}
