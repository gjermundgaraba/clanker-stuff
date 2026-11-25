import { randomBytes } from "node:crypto";

import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createActor } from "xstate";
import type { Actor } from "xstate";

import { WakeGate } from "./gate.js";
import { ENDED, labelOf, liveWaitsAcrossBranches, OPENED } from "./journal.js";
import type { Ended, Opened } from "./journal.js";
import { waitMachine } from "./machine.js";
import type { WaitSnapshot } from "./machine.js";
import { rowOf, wakeDetails, wakeText } from "./report.js";
import type { WaitRow } from "./report.js";
import { DEFAULTS } from "./spec.js";
import type { StartRequest } from "./spec.js";
import { WaitsView } from "./widget.js";
import type { LiveWait as WaitView } from "./widget.js";

export const WAKE_TYPE = "waits:wake";

interface LiveWait {
  readonly actor: Actor<typeof waitMachine>;
  readonly expiresAt: number;
  readonly stop: () => void;
}

const outlivesPrompt = (ctx: ExtensionContext): boolean =>
  ctx.mode === "tui" || ctx.mode === "rpc";

export class WaitRuntime {
  private readonly pi: ExtensionAPI;
  private readonly waits = new Map<string, LiveWait>();
  private ctx: ExtensionContext | undefined;
  private readonly view = new WaitsView(() => this.live());
  readonly gate = new WakeGate({
    context: () => this.ctx,
    hasWork: () => this.finished().length > 0,
    deliver: () => {
      this.deliver();
    },
  });

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  startSession(ctx: ExtensionContext): void {
    this.ctx = ctx;

    if (!outlivesPrompt(ctx)) {
      return;
    }

    const owner = ctx.sessionManager.getSessionId();

    for (const wait of liveWaitsAcrossBranches(
      ctx.sessionManager.getEntries(),
      owner
    )) {
      this.start(wait);
    }

    this.changed();
    this.gate.request();
  }

  shutdown(): void {
    for (const wait of this.waits.values()) {
      wait.stop();
    }

    this.waits.clear();
    this.gate.clear();
    this.changed();
    this.ctx = undefined;
  }

  open(request: StartRequest, ctx: ExtensionContext): WaitRow {
    if (!outlivesPrompt(ctx)) {
      throw new Error(
        "Waits need a live TUI or RPC session; print and JSON runs end with their prompt."
      );
    }

    const wait: Opened = {
      id: `w_${randomBytes(4).toString("hex")}`,
      owner: ctx.sessionManager.getSessionId(),
      spec: {
        label: request.label,
        condition: request.condition,
        instruction: request.instruction,
        cwd: ctx.cwd,
        intervalSeconds: request.intervalSeconds ?? DEFAULTS.intervalSeconds,
        checkTimeoutSeconds:
          request.checkTimeoutSeconds ?? DEFAULTS.checkTimeoutSeconds,
      },
      expiresAt:
        Date.now() + (request.timeoutSeconds ?? DEFAULTS.timeoutSeconds) * 1000,
    };

    this.pi.appendEntry(OPENED, wait);
    this.start(wait);

    return this.row(wait.id);
  }

  cancel(id: string): WaitRow {
    const row = this.row(id);
    this.end(id, "cancelled");

    return { ...row, state: "cancelled" };
  }

  rows(): WaitRow[] {
    return [...this.waits.values()].map((wait) =>
      rowOf(wait.actor.getSnapshot())
    );
  }

  live(): WaitView[] {
    return [...this.waits.values()].map((wait) => ({
      snapshot: wait.actor.getSnapshot(),
      expiresAt: wait.expiresAt,
    }));
  }

  labelOf(id: string): string | undefined {
    return this.ctx === undefined
      ? undefined
      : labelOf(this.ctx.sessionManager.getEntries(), id);
  }

  private row(id: string): WaitRow {
    const wait = this.waits.get(id);

    if (!wait) {
      throw new Error(`No live wait ${id} in this session.`);
    }

    return rowOf(wait.actor.getSnapshot());
  }

  private start(wait: Opened): void {
    const actor = createActor(waitMachine, {
      input: {
        id: wait.id,
        spec: wait.spec,
        remainingMs: Math.max(0, wait.expiresAt - Date.now()),
      },
    });

    const subscription = actor.subscribe((snapshot) => {
      if (snapshot.status === "done") {
        this.gate.request();
      }
    });

    this.waits.set(wait.id, {
      actor,
      expiresAt: wait.expiresAt,
      stop: () => {
        subscription.unsubscribe();
        actor.stop();
      },
    });
    actor.start();
    this.changed();
  }

  private end(id: string, outcome: Ended["outcome"]): void {
    const wait = this.waits.get(id);

    if (!wait) {
      throw new Error(`No live wait ${id} in this session.`);
    }

    this.pi.appendEntry(ENDED, { id, outcome } satisfies Ended);
    wait.stop();
    this.waits.delete(id);
    this.changed();
  }

  private finished(): WaitSnapshot[] {
    return [...this.waits.values()].flatMap((wait) => {
      const snapshot = wait.actor.getSnapshot();

      return snapshot.status === "done" ? [snapshot] : [];
    });
  }

  private deliver(): void {
    // Why: each wait is journaled as ended before the wake, so a Pi that dies
    // in between loses the wake rather than repeating it; a repeated wake can
    // act on a result twice.
    const delivered: WaitSnapshot[] = [];

    try {
      for (const snapshot of this.finished()) {
        this.end(
          snapshot.context.id,
          snapshot.matches("satisfied") ? "satisfied" : "expired"
        );
        delivered.push(snapshot);
      }
    } catch (error) {
      this.ctx?.ui.notify(
        `A finished wait could not be recorded, so it was not delivered yet: ${errorMessage(error)}`,
        "warning"
      );
    }

    if (delivered.length) {
      this.pi.sendMessage(
        {
          customType: WAKE_TYPE,
          content: wakeText(delivered),
          display: true,
          details: wakeDetails(delivered),
        },
        { triggerTurn: true }
      );
    }
  }

  private changed(): void {
    this.view.update(this.ctx);
  }
}
