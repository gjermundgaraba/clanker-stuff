import { randomUUID } from "node:crypto";

import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { delivered, outcome, sendOutcome, toolResult } from "./delivery.js";
import type { Outcome } from "./delivery.js";
import {
  collectAnswers,
  createInteraction,
  transition,
} from "./interaction.js";
import type { Action, Draft, Interaction } from "./interaction.js";
import { recordRequest, recordState, replay } from "./journal.js";
import { createPromptQueue } from "./prompts.js";
import { showInboxCount } from "./status.js";
import { showQuestionnaire } from "./tui/controller.js";
import type { FormResult } from "./tui/controller.js";
import { showInbox } from "./tui/inbox.js";

export class Coordinator {
  private ctx: ExtensionContext | undefined;
  /** Every questionnaire seen on the branch, in the order of its latest change. */
  private items = new Map<string, Interaction>();
  private lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  /** Questionnaires whose tool call is still waiting for the outcome. */
  private readonly waiting = new Set<string>();
  /** Drafts hidden while their outcomes are handed to Pi, until a turn boundary. */
  private readonly inFlight = new Map<string, Draft>();
  private flushView: (() => void) | undefined;
  private inboxOpen = false;
  readonly prompt = createPromptQueue();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }
  attach(ctx: ExtensionContext): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.ctx = ctx;
    this.items = replay(ctx.sessionManager.getBranch());
    this.inFlight.clear();
    this.update();
  }
  private static owner(lifetime: AbortSignal): void {
    if (lifetime.aborted) {
      throw new Error("Questionnaire belongs to an inactive session branch");
    }
  }
  /** Open questionnaires, most recently changed first. */
  list(): Interaction[] {
    return [...this.items.values()]
      .filter((item) => item.draft !== undefined)
      .toReversed();
  }
  get(id: string): Interaction {
    const item = this.items.get(id);

    if (!item) {
      throw new Error(`Unknown questionnaire ${id}`);
    }

    return item;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(): void {
    if (this.ctx) {
      showInboxCount(this.ctx, this.list().length);
    }

    for (const listener of this.listeners) {
      listener();
    }
  }
  private save(item: Interaction): Interaction {
    recordState(this.pi, item);

    return this.remember(item);
  }
  private remember(item: Interaction): Interaction {
    this.items.delete(item.id);
    this.items.set(item.id, item);
    this.update();

    return item;
  }
  mutate(
    id: string,
    action: Action,
    lifetime = this.lifetime.signal
  ): Interaction {
    Coordinator.owner(lifetime);

    return this.save(transition(this.get(id), action));
  }
  async ask(
    request: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext
  ) {
    signal?.throwIfAborted();

    const created = createInteraction(`q_${randomUUID()}`, request);
    recordRequest(this.pi, created);
    const item = this.save(created);

    if (!item.request.wait) {
      ctx.ui.notify(
        `New questionnaire · ${item.request.title ?? "Questions"} · /answers to answer`,
        "info"
      );

      return toolResult(outcome(item, "pending"));
    }

    const lifetime = this.lifetime.signal;
    this.waiting.add(item.id);

    try {
      const result = await this.open(item.id, ctx, signal);
      Coordinator.owner(lifetime);

      if (result === "closed") {
        ctx.abort();
      } else if (result !== "stopped") {
        return toolResult(result);
      }

      return { ...toolResult(outcome(item, "closed")), terminate: true };
    } finally {
      this.waiting.delete(item.id);
    }
  }
  async open(
    id: string,
    ctx: ExtensionContext,
    runSignal?: AbortSignal
  ): Promise<FormResult> {
    const lifetime = this.lifetime.signal;

    const signal = runSignal
      ? AbortSignal.any([runSignal, lifetime])
      : lifetime;

    const waiting = this.waiting.has(id);

    return await this.prompt(signal, async (active) => {
      Coordinator.owner(lifetime);
      const item = this.get(id);

      if (!item.draft) {
        return "stopped";
      }

      try {
        return await showQuestionnaire(ctx, item, active, {
          mutate: (action) => this.mutate(id, action, lifetime),
          current: () => this.get(id),
          subscribe: (listener) => this.subscribe(listener),
          finish: (kind) => this.finish(id, kind, ctx, lifetime),
          waiting,
          setFlush: (flush) => {
            this.flushView = flush;
          },
          report: (error) => {
            Coordinator.report(error, ctx);
          },
        });
      } finally {
        this.flushView = undefined;
      }
    });
  }
  /**
   * Submits or dismisses a draft. A waiting tool call returns the outcome itself; any other
   * outcome reaches the agent as a message.
   */
  private finish(
    id: string,
    kind: "submit" | "dismiss",
    ctx: ExtensionContext,
    lifetime: AbortSignal
  ): Outcome {
    Coordinator.owner(lifetime);
    const before = this.get(id);
    const answers = kind === "submit" ? collectAnswers(before) : undefined;
    const after = transition(before, { type: kind });

    const result = outcome(
      after,
      kind === "submit" ? "answered" : "dismissed",
      answers
    );

    if (this.waiting.has(id)) {
      this.save(after);

      return result;
    }

    this.remember(after);

    if (before.draft) {
      this.inFlight.set(id, before.draft);
    }

    const running = !ctx.isIdle();
    sendOutcome(this.pi, result, kind === "submit" || running);
    ctx.ui.notify(
      kind === "submit" ? "Answers submitted" : "Questionnaire dismissed",
      "info"
    );

    return result;
  }
  /** Reopen outcomes Pi did not record, including messages dropped when a run stops. */
  settled(ctx: ExtensionContext): void {
    const sent = [...this.inFlight];
    this.inFlight.clear();

    const branch = ctx.sessionManager.getBranch();

    for (const [id, draft] of sent) {
      const item = this.items.get(id);

      if (item && !item.draft && !delivered(branch, id)) {
        this.remember(transition(item, { type: "restore", draft }));
        ctx.ui.notify(
          `The outcome for ${item.request.title ?? "a questionnaire"} did not reach the session · /answers to try again`,
          "warning"
        );
      }
    }
  }
  async answer(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      throw new Error(
        "Questionnaires require an interactive TUI; this channel is unavailable"
      );
    }

    if (this.inboxOpen) {
      return;
    }

    this.inboxOpen = true;

    try {
      await showInbox(ctx, this, this.lifetime.signal);
    } finally {
      this.inboxOpen = false;
    }
  }
  flush(): void {
    try {
      this.flushView?.();
    } catch (error) {
      if (this.ctx) {
        Coordinator.report(error, this.ctx);
      }
    }
  }
  shutdown(): void {
    this.flush();
    this.lifetime.abort();
    this.listeners.clear();

    if (this.ctx) {
      showInboxCount(this.ctx, 0);
    }

    this.ctx = undefined;
  }
  private static report(cause: unknown, ctx: ExtensionContext): void {
    ctx.ui.notify(errorMessage(cause), "error");
  }
}
