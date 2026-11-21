import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import { parkedReportSchema } from "@clanker-stuff/presence-protocol";
import type { ParkedItem } from "@clanker-stuff/presence-protocol";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { presenceDir, pruneRecords, writeRecord } from "./record.ts";
import type { PresenceRecord } from "./record.ts";

interface Live {
  readonly ctx: ExtensionContext;
  readonly sessionId: string;
  readonly startedAt: number;
}

const outlivesPrompt = (ctx: ExtensionContext): boolean =>
  ctx.mode === "tui" || ctx.mode === "rpc";

/**
 * Keeps this Pi's presence record current: who it is, whether its agent is
 * running, in a dialog or idle, and what work it has parked with other
 * extensions. Every change rewrites the record; writes never overlap, and
 * the last one always lands.
 */
export class PresenceTracker {
  private readonly pi: ExtensionAPI;
  private live: Live | undefined;
  private running = false;
  private dialogs = 0;
  private readonly tools = new Map<string, string>();
  private shown: PresenceRecord["activity"] = "idle";
  private since = Date.now();
  private endedAt: number | undefined;
  private readonly parked = new Map<string, readonly ParkedItem[]>();
  private dirty = false;
  private writing: Promise<void> | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  start(ctx: ExtensionContext): void {
    if (!outlivesPrompt(ctx)) {
      return;
    }

    const now = Date.now();

    this.live = {
      ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      startedAt: now,
    };
    this.endedAt = undefined;
    this.changed();
    void pruneRecords(presenceDir(), now).catch(() => undefined);
  }

  agentStarted(): void {
    this.running = true;
    this.changed();
  }

  agentSettled(): void {
    this.running = false;
    this.tools.clear();
    this.changed();
  }

  toolStarted(id: string, name: string): void {
    this.tools.set(id, name);
    this.changed();
  }

  toolEnded(id: string): void {
    this.tools.delete(id);
    this.changed();
  }

  dialogOpened(): void {
    this.dialogs += 1;
    this.changed();
  }

  dialogClosed(): void {
    this.dialogs = Math.max(0, this.dialogs - 1);
    this.changed();
  }

  renamed(): void {
    this.changed();
  }

  report(data: unknown): void {
    if (!Value.Check(parkedReportSchema, data)) {
      return;
    }

    this.parked.set(data.source, data.items);
    this.changed();
  }

  async shutdown(): Promise<void> {
    if (this.live) {
      this.endedAt = Date.now();
      this.changed();
    }

    await this.writing;
    this.live = undefined;
    this.parked.clear();
    this.running = false;
    this.dialogs = 0;
    this.tools.clear();
  }

  private activity(): PresenceRecord["activity"] {
    if (this.dialogs > 0) {
      return "dialog";
    }

    return this.running ? "busy" : "idle";
  }

  private changed(): void {
    const activity = this.activity();

    if (activity !== this.shown) {
      this.shown = activity;
      this.since = Date.now();
    }

    if (!this.live) {
      return;
    }

    this.dirty = true;
    this.writing ??= this.flush();
  }

  private record(live: Live): PresenceRecord {
    const name = this.pi.getSessionName();
    const tool = [...this.tools.values()].at(-1);

    return {
      pid: process.pid,
      sessionId: live.sessionId,
      ...(name === undefined ? {} : { name }),
      cwd: live.ctx.cwd,
      startedAt: live.startedAt,
      updatedAt: Date.now(),
      activity: this.activity(),
      since: this.since,
      ...(tool === undefined ? {} : { tool }),
      parked: [...this.parked].flatMap(([source, items]) =>
        items.map((item) => ({ ...item, source }))
      ),
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
    };
  }

  private async flush(): Promise<void> {
    while (this.dirty && this.live) {
      this.dirty = false;

      try {
        await writeRecord(presenceDir(), this.record(this.live));
      } catch (error) {
        this.live.ctx.ui.notify(
          `presence: could not write this session's record: ${errorMessage(error)}`,
          "warning"
        );
      }
    }

    this.writing = undefined;
  }
}
