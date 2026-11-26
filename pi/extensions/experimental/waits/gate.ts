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

export class WakeGate {
  private prompting = false;
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
  }

  clear(): void {
    this.check.clear();
  }

  private tick(): void {
    const ctx = this.target.context();

    if (!ctx || !this.target.hasWork()) {
      return;
    }

    if (this.prompting || !ctx.isIdle() || ctx.hasPendingMessages()) {
      this.check.request(RECHECK_MS);

      return;
    }

    this.target.deliver();
  }
}
