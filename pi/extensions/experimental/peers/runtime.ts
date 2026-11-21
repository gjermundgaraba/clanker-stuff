import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import { createScheduledCheck } from "@clanker-stuff/scheduled-check";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { SENT, UNDELIVERED, undeliveredText } from "./entries.js";
import type { Undelivered } from "./entries.js";
import { post, take } from "./mailbox.js";
import type { Letter } from "./mailbox.js";
import { claim, livePeers, lookup, release } from "./registry.js";
import { letterText } from "./report.js";
import type { PeerList } from "./report.js";

export const MESSAGE_TYPE = "peers:message";

const STATUS_KEY = "peers.name";

const TICK_MS = 1000;

const outlivesPrompt = (ctx: ExtensionContext): boolean =>
  ctx.mode === "tui" || ctx.mode === "rpc";

/**
 * Makes this session reachable by its Pi session name and delivers what
 * other sessions send it. One reconcile step, run every second and whenever
 * the name changes, does all of its file writes: it moves the registry entry
 * to the current name and empties this session's inbox. Sending only reads
 * the registry and writes into another session's inbox.
 */
export class PeerRuntime {
  private readonly pi: ExtensionAPI;
  private ctx: ExtensionContext | undefined;
  private held: { name: string; sessionId: string } | undefined;
  private conflict: string | undefined;
  private running: Promise<void> | undefined;
  private readonly check = createScheduledCheck(() => {
    void this.reconcile();
  });

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  private static dirs() {
    const { dataDir } = getExtensionStoragePaths("peers");

    return {
      names: path.join(dataDir, "names"),
      inbox: path.join(dataDir, "inbox"),
    };
  }

  startSession(ctx: ExtensionContext): void {
    if (!outlivesPrompt(ctx)) {
      return;
    }

    this.ctx = ctx;
    this.check.request(0);
  }

  renamed(): void {
    if (this.ctx) {
      this.check.request(0);
    }
  }

  async shutdown(): Promise<void> {
    this.ctx = undefined;
    this.check.clear();
    await this.running;

    const { held } = this;

    this.held = undefined;
    this.conflict = undefined;

    if (held) {
      await release(PeerRuntime.dirs().names, held.name, held.sessionId);
    }
  }

  async send(to: string, text: string, ctx: ExtensionContext): Promise<Letter> {
    const { names, inbox } = PeerRuntime.dirs();
    const from = this.held;
    const self = ctx.sessionManager.getSessionId();
    const live = await livePeers(names);
    const others = live.filter((p) => p.sessionId !== self).map((p) => p.name);

    const refuse = (reason: string): never => {
      const undelivered: Undelivered = { to, text, reason, live: others };

      this.pi.appendEntry(UNDELIVERED, undelivered);
      throw new Error(undeliveredText(undelivered));
    };

    if (!from || from.sessionId !== self) {
      return refuse(
        this.conflict ??
          "this session has no peer name, so nobody could reply; name it with /name <name>, then send again"
      );
    }

    const peer = await lookup(names, to);

    if (!peer) {
      return refuse("no live session has that name");
    }

    if (peer.sessionId === self) {
      return refuse("that name is this session");
    }

    const letter = await post(inbox, peer.sessionId, {
      from: from.name,
      to,
      text,
      sentAt: Date.now(),
    });

    this.pi.appendEntry(SENT, letter);

    return letter;
  }

  async peers(): Promise<PeerList> {
    return {
      peers: await livePeers(PeerRuntime.dirs().names),
      ...(this.held ? { self: this.held.sessionId } : {}),
    };
  }

  private async reconcile(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = this.step().finally(() => {
      this.running = undefined;

      if (this.ctx) {
        this.check.request(TICK_MS);
      }
    });
    await this.running;
  }

  private async step(): Promise<void> {
    const { ctx } = this;

    if (!ctx) {
      return;
    }

    try {
      await this.register(ctx);
      await this.deliver(ctx.sessionManager.getSessionId());
    } catch (error) {
      ctx.ui.notify(`peers: ${errorMessage(error)}`, "warning");
    }
  }

  private async register(ctx: ExtensionContext): Promise<void> {
    const { names } = PeerRuntime.dirs();
    const name = this.pi.getSessionName();
    const sessionId = ctx.sessionManager.getSessionId();
    const { held } = this;

    if (
      held !== undefined &&
      held.name === name &&
      held.sessionId === sessionId
    ) {
      return;
    }

    if (held) {
      await release(names, held.name, held.sessionId);
      this.held = undefined;
    }

    const holder =
      name === undefined
        ? undefined
        : await claim(names, {
            name,
            sessionId,
            pid: process.pid,
            cwd: ctx.cwd,
          });

    const conflict = holder
      ? `Another live session (pid ${holder.pid}) is already named "${name}", so this one cannot send or be reached. Rename one of them with /name.`
      : undefined;

    if (name !== undefined && !holder) {
      this.held = { name, sessionId };
    }

    if (conflict !== undefined && conflict !== this.conflict) {
      ctx.ui.notify(`peers: ${conflict}`, "warning");
    }

    this.conflict = conflict;
    this.showStatus(ctx);
  }

  /**
   * Hands each waiting letter to Pi as a message that starts a turn, or
   * follows the current one. The letter file is deleted first, so delivery is
   * at most once: a Pi that dies in between loses the letter.
   */
  private async deliver(sessionId: string): Promise<void> {
    for (const letter of await take(PeerRuntime.dirs().inbox, sessionId)) {
      this.pi.sendMessage(
        {
          customType: MESSAGE_TYPE,
          content: letterText(letter),
          display: true,
          details: letter,
        },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    }
  }

  private showStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      return;
    }

    ctx.ui.setStatus(
      STATUS_KEY,
      this.held ? ctx.ui.theme.fg("accent", `✉ ${this.held.name}`) : undefined
    );
  }
}
