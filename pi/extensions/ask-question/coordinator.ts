import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runQueuedPrompt } from "@clanker-stuff/pi-user-input/queue";
import { Journal } from "./journal.js";
import { awaitingUser, createInteraction, transition } from "./interaction.js";
import type { Action, Draft, Interaction, Mode } from "./interaction.js";
import { answerMessage, answerResult, isDelivered } from "./delivery.js";
import type { Questionnaire, Revision } from "./request.js";
import { showQuestionnaire } from "./tui/controller.js";
import { createInboxStatus } from "./status.js";
import { showInbox } from "./tui/inbox.js";

export const QUESTION_TOOLS = new Set([
  "request_user_input",
  "request_user_input_async",
  "revise_user_input",
]);

export class Coordinator {
  private ctx: ExtensionContext | undefined;
  private journal?: Journal;
  private items = new Map<string, Interaction>();
  private lifetime = new AbortController();
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private runSignal: AbortSignal | undefined;
  private detachRun = () => {};
  private readonly stopped = new Set<string>();
  private readonly blocking = new Set<string>();
  private flushView: (() => Promise<void>) | undefined;
  private inboxOpen = false;
  private recoveryError: Error | undefined;

  private readonly status: ReturnType<typeof createInboxStatus>;
  constructor(private readonly pi: ExtensionAPI) {
    this.status = createInboxStatus(pi);
  }
  availability(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI)
      this.pi.setActiveTools(this.pi.getActiveTools().filter((n) => !QUESTION_TOOLS.has(n)));
  }
  attach(ctx: ExtensionContext, navigationId: string | null = null): void {
    this.epoch++;
    this.lifetime.abort();
    this.detachRun();
    this.runSignal = undefined;
    this.lifetime = new AbortController();
    this.ctx = ctx;
    this.status.attach(ctx, navigationId);
    this.journal = new Journal(this.pi, ctx);
    this.items.clear();
    this.recoveryError = undefined;
    this.availability(ctx);

    try {
      this.items = this.journal.replay();
    } catch (cause) {
      this.recoveryError = new Error(
        "Questionnaire recovery failed; reopen a verified session file",
        { cause },
      );
      this.update();
      throw this.recoveryError;
    }

    this.stopped.clear();

    for (const item of this.items.values()) this.stopped.add(item.id);
    this.availability(ctx);
    this.update();
  }
  private owner(ctx: ExtensionContext, epoch = this.epoch): void {
    if (
      epoch !== this.epoch ||
      this.lifetime.signal.aborted ||
      !this.ctx ||
      this.ctx.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()
    )
      throw new Error("Questionnaire belongs to an inactive session branch");
  }
  private channel(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI)
      throw new Error("Questionnaires require an interactive TUI; this channel is unavailable");
    this.owner(ctx);

    if (this.recoveryError) throw this.recoveryError;
  }
  private queue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => {}); // The caller receives the original rejection.

    return result;
  }
  list(): Interaction[] {
    return [...this.items.values()]
      .map((i) => structuredClone(i))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  get(id: string): Interaction {
    const item = this.items.get(id);

    if (!item)
      throw new Error(
        `Unknown interaction_id ${id}: it must name a questionnaire already asked in this session`,
      );

    return structuredClone(item);
  }
  /** Read-only lookup for renderers; never throws. */
  peek(id: string): Interaction | undefined {
    return this.items.get(id);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }
  private update(): void {
    const waiting = [...this.items.values()].filter(awaitingUser);
    const paused = waiting.filter((i) => i.paused || this.stopped.has(i.id)).length;
    this.status.update(waiting.length, paused);

    for (const listener of this.listeners) listener();
  }
  mutate(
    id: string,
    expected: number,
    action: Action,
    ctx: ExtensionContext,
    unchangedDraft?: Draft,
  ): Promise<Interaction> {
    const epoch = this.epoch;

    return this.queue(async () => {
      this.channel(ctx);
      this.owner(ctx, epoch);
      const item = this.get(id);

      // Rebase a view only over bookkeeping changes, under the same serialized lock.
      const version =
        unchangedDraft && JSON.stringify(item.draft) === JSON.stringify(unchangedDraft)
          ? item.version
          : expected;

      const next = transition(item, version, action);

      if (action.type !== "resume" && this.stopped.has(id)) next.paused = true;
      await this.journal!.checkpoint(next, () => this.owner(ctx, epoch));
      this.items.set(id, next);

      if (action.type === "resume") this.stopped.delete(id);
      this.update();

      return structuredClone(next);
    });
  }
  observeRun(ctx: ExtensionContext): void {
    this.availability(ctx);
    const signal = ctx.signal;

    if (!signal || this.runSignal === signal) return;
    this.detachRun();
    this.runSignal = signal;
    const epoch = this.epoch;

    const abort = () => {
      if (epoch !== this.epoch) return;

      for (const id of this.items.keys()) this.stopped.add(id);
      this.update();
      void this.queue(async () => {
        this.owner(ctx, epoch);

        for (const [id, item] of this.items) {
          if (item.paused) continue;
          const next = transition(item, item.version, { type: "pause" });
          await this.journal!.checkpoint(next, () => this.owner(ctx, epoch));
          this.items.set(id, next);
        }

        this.update();
      }).catch((error) => this.report(error, ctx));
    };

    signal.addEventListener("abort", abort, { once: true });
    this.detachRun = () => signal.removeEventListener("abort", abort);

    if (signal.aborted) abort();
  }
  async reconcile(ctx: ExtensionContext): Promise<void> {
    const epoch = this.epoch;
    await this.queue(async () => {
      this.owner(ctx, epoch);

      if (!this.items.size) return;
      this.journal!.verify();
      const branch = ctx.sessionManager.getBranch();

      for (const [id, item] of this.items) {
        let next = item;

        for (const submission of item.submissions) {
          const delivery = next.deliveries.find((d) => d.revision === submission.revision)!;

          if (delivery.status !== "delivered" && isDelivered(item, submission, branch))
            next = transition(next, next.version, {
              type: "delivery",
              revision: submission.revision,
              status: "delivered",
            });
        }

        if (next !== item) {
          await this.journal!.checkpoint(next, () => this.owner(ctx, epoch));
          this.items.set(id, next);
        }
      }

      this.update();
    });
  }
  async ask(
    toolCallId: string,
    request: Questionnaire,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    mode: Mode,
  ) {
    const epoch = this.begin(ctx, signal);

    const item = await this.queue(async () => {
      this.owner(ctx, epoch);
      signal?.throwIfAborted();

      if (request.linked_interaction_id) this.get(request.linked_interaction_id);
      const created = createInteraction(`q_${randomUUID()}`, request, toolCallId, mode);
      await this.journal!.checkpoint(created, () => this.owner(ctx, epoch));
      this.items.set(created.id, created);

      if (signal?.aborted) {
        this.stopped.add(created.id);
        const paused = transition(created, created.version, { type: "pause" });
        await this.journal!.checkpoint(paused, () => this.owner(ctx, epoch));
        this.items.set(created.id, paused);
      }

      this.update();

      return this.get(created.id);
    });

    return this.deliver(item, mode, "New questionnaire", signal, ctx, epoch);
  }
  async revise(
    toolCallId: string,
    revision: Revision,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    const epoch = this.begin(ctx, signal);
    const prior = this.get(revision.interaction_id);
    // A revision reopens the questionnaire the way it was last asked.
    const mode = prior.submissions.at(-1)?.mode ?? prior.draft?.mode ?? "blocking";

    const item = await this.mutate(
      prior.id,
      prior.version,
      {
        type: "reopen",
        base: revision.base_revision,
        initiated_by: "agent",
        mode,
        tool_call_id: toolCallId,
        reason: revision.reason,
      },
      ctx,
    );

    return this.deliver(item, mode, "Revision requested", signal, ctx, epoch);
  }
  private begin(ctx: ExtensionContext, signal: AbortSignal | undefined) {
    this.channel(ctx);
    signal?.throwIfAborted();
    this.observeRun(ctx);

    return this.epoch;
  }
  private async deliver(
    item: Interaction,
    mode: Mode,
    notice: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    epoch: number,
  ) {
    if (mode === "async") {
      ctx.ui.notify(`${notice} · ${item.request.title ?? item.id} · /answers to review`, "info");
      const details = { accepted: true, status: "pending", interaction_id: item.id };

      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    this.blocking.add(item.id);
    this.pi.events.emit("herdr:blocked", { active: true, label: "Waiting for answers" });

    try {
      const result = signal?.aborted ? "stopped" : await this.open(item.id, ctx, signal);
      this.owner(ctx, epoch);

      if (result === "submitted" && !signal?.aborted) {
        const current = this.get(item.id);
        const submission = current.submissions.at(-1)!;
        await this.mutate(
          current.id,
          current.version,
          { type: "delivery", revision: submission.revision, status: "handed_to_pi" },
          ctx,
        );

        if (!signal?.aborted) return answerResult(current, submission);
      }

      if (result === "cancelled" || result === "closed") ctx.abort();

      const details = {
        interaction_id: item.id,
        status: result === "cancelled" ? "cancelled" : "delivery_paused",
        aborted_run: true,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
        terminate: true,
      };
    } finally {
      this.blocking.delete(item.id);
      this.pi.events.emit("herdr:blocked", { active: false });
    }
  }
  async open(id: string, ctx: ExtensionContext, runSignal?: AbortSignal) {
    this.channel(ctx);
    const epoch = this.epoch;

    const signal = runSignal
      ? AbortSignal.any([runSignal, this.lifetime.signal])
      : this.lifetime.signal;

    const asyncView = !this.blocking.has(id);

    return runQueuedPrompt(ctx, signal, async (activeSignal) => {
      this.owner(ctx, epoch);

      if (asyncView) this.pi.events.emit("clanker:async-prompt", { active: true });

      try {
        return await showQuestionnaire(ctx, this.get(id), activeSignal, {
          mutate: (version, action, draft) => this.mutate(id, version, action, ctx, draft),
          current: () => this.get(id),
          subscribe: (listener) => this.subscribe(listener),
          send: (revision, uncertain) => this.send(id, revision, ctx, uncertain),
          blocking: !asyncView,
          setFlush: (flush) => {
            this.flushView = flush;
          },
          notify: (text) => ctx.ui.notify(text, "info"),
          report: (error) => this.report(error, ctx),
        });
      } finally {
        this.flushView = undefined;

        if (asyncView) this.pi.events.emit("clanker:async-prompt", { active: false });
      }
    });
  }
  async send(
    id: string,
    revision: number,
    ctx: ExtensionContext,
    allowUncertain = false,
  ): Promise<void> {
    this.channel(ctx);
    await this.reconcile(ctx);
    let current = this.get(id);
    const delivery = current.deliveries.find((d) => d.revision === revision);
    const submission = current.submissions.find((s) => s.revision === revision);

    if (!delivery || !submission) throw new Error("Unknown submission");

    if (delivery.status === "delivered") return;

    if ((delivery.status === "handed_to_pi" || delivery.status === "uncertain") && !allowUncertain)
      throw new Error(
        "Pi may already own this answer. Review history/editor before explicitly resending",
      );
    // Called only by an explicit Send/Submit-and-continue action, never replay or agent lifecycle.
    current = await this.mutate(id, current.version, { type: "resume" }, ctx);
    const epoch = this.epoch;
    await this.queue(async () => {
      this.owner(ctx, epoch);
      const latest = this.get(id);

      if (latest.paused || this.stopped.has(id))
        throw new Error("Delivery paused by interruption; use /answers to resume");

      const handed = transition(latest, latest.version, {
        type: "delivery",
        revision,
        status: "handed_to_pi",
      });

      await this.journal!.checkpoint(handed, () => this.owner(ctx, epoch));
      this.items.set(id, handed);

      // The public API returns void: pending/failed preflight remains visibly uncertain until canonical reconciliation.
      if (this.stopped.has(id))
        throw new Error("Delivery paused before queue handoff; review this submission in /answers");
      this.pi.sendUserMessage(answerMessage(handed, submission), { deliverAs: "steer" });
      this.update();
      ctx.ui.notify("Answers sent", "info");
    });
  }
  async answer(ctx: ExtensionContext): Promise<void> {
    this.channel(ctx);

    if (this.inboxOpen) return;
    this.inboxOpen = true;

    try {
      await this.reconcile(ctx);
      await showInbox(ctx, this, this.lifetime.signal, this.pi);
    } finally {
      this.inboxOpen = false;
    }
  }
  async flush(): Promise<void> {
    await this.flushView?.();
    await this.tail;
  }
  async beforeNavigation(ctx: ExtensionContext) {
    try {
      await this.flush();
    } catch (error) {
      this.report(error, ctx);

      return { cancel: true };
    }
  }
  async shutdown(): Promise<void> {
    try {
      await this.flush();
    } catch (error) {
      if (this.ctx) this.report(error, this.ctx);
    }

    this.epoch++;
    this.lifetime.abort();
    this.detachRun();
    await this.tail;
    this.status.dispose();
    this.listeners.clear();
    this.ctx = undefined;
  }
  report(cause: unknown, ctx: ExtensionContext): void {
    ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
  }
  async settled(ctx: ExtensionContext): Promise<void> {
    try {
      await this.reconcile(ctx);
    } catch (error) {
      this.report(error, ctx);
    }
  }
}
