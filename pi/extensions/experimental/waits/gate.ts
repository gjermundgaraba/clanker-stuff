import { createScheduledCheck } from "@clanker-stuff/scheduled-check";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SOON_MS = 100;
const RECHECK_MS = 1000;

export interface GateTarget {
  readonly context: () =>
    | Pick<ExtensionContext, "isIdle" | "hasPendingMessages">
    | undefined;
  readonly hasWork: () => boolean;
  readonly deliver: () => void;
}

/**
 * Decides when a wake may be handed to Pi: only while it is idle, with no
 * queued message, extension dialog or compaction in progress. Dialogs and
 * compaction end without `agent_settled`, so a busy gate rechecks itself.
 */
export class WakeGate {
  private prompting = false;
  private compacting = false;
  private readonly target: GateTarget;
  private readonly check = createScheduledCheck(() => {
    this.tick();
  });

  constructor(target: GateTarget) {
    this.target = target;
  }

  request(): void {
    this.check.request(SOON_MS);
  }

  settled(): void {
    this.check.clear();
    this.tick();
  }

  setPrompting(active: boolean): void {
    this.prompting = active;
    this.request();
  }

  setCompacting(active: boolean): void {
    this.compacting = active;
    this.request();
  }

  clear(): void {
    this.check.clear();
  }

  private tick(): void {
    const ctx = this.target.context();

    if (!ctx || !this.target.hasWork()) {
      return;
    }

    if (
      this.prompting ||
      this.compacting ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    ) {
      this.check.request(RECHECK_MS);

      return;
    }

    this.target.deliver();
  }
}
