import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordRequest, recordState, replay } from "./journal.js";
import { awaitingUser, createInteraction, transition } from "./interaction.js";
import type { Action, Interaction, Mode } from "./interaction.js";
import { answerEnvelope, answerMessage, answerResult } from "./delivery.js";
import { createPromptQueue } from "./prompts.js";
import type { Revision } from "./request.js";
import { showQuestionnaire } from "./tui/controller.js";
import { showInboxCount } from "./status.js";
import { showInbox } from "./tui/inbox.js";

export class Coordinator {
  private ctx: ExtensionContext | undefined;
  private items = new Map<string, Interaction>();
  /** Aborted when the branch changes or the session ends; captured signals fence earlier views. */
  private lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly blocking = new Set<string>();
  private flushView: (() => void) | undefined;
  private inboxOpen = false;
  readonly prompt = createPromptQueue();
  constructor(private readonly pi: ExtensionAPI) {}
  attach(ctx: ExtensionContext): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.ctx = ctx;
    this.items = replay(ctx.sessionManager.getBranch());
    this.update();
  }
  private owner(lifetime: AbortSignal): void {
    if (lifetime.aborted) throw new Error("Questionnaire belongs to an inactive session branch");
  }
  list(): Interaction[] {
    return [...this.items.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  get(id: string): Interaction {
    const item = this.items.get(id);

    if (!item)
      throw new Error(
        `Unknown interaction_id ${id}: it must name a questionnaire already asked in this session`,
      );

    return item;
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
    if (this.ctx) showInboxCount(this.ctx, [...this.items.values()].filter(awaitingUser).length);

    for (const listener of this.listeners) listener();
  }
  private save(item: Interaction, created = false): Interaction {
    if (created) recordRequest(this.pi, item);
    recordState(this.pi, item);
    this.items.set(item.id, item);
    this.update();

    return item;
  }
  mutate(id: string, action: Action, lifetime = this.lifetime.signal): Interaction {
    this.owner(lifetime);

    return this.save(transition(this.get(id), action));
  }
  async ask(
    toolCallId: string,
    request: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    mode: Mode,
  ) {
    signal?.throwIfAborted();
    const created = createInteraction(`q_${randomUUID()}`, request, toolCallId, mode);
    const linked = created.request.linked_interaction_id;

    if (linked) this.get(linked);
    const item = this.save(created, true);

    return this.deliver(item, mode, "New questionnaire", signal, ctx);
  }
  async revise(
    toolCallId: string,
    revision: Revision,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    signal?.throwIfAborted();

    // Without an explicit mode, the revision reopens the questionnaire the way it was last asked.
    const item = this.mutate(revision.interaction_id, {
      type: "reopen",
      base: revision.base_revision,
      initiated_by: "agent",
      tool_call_id: toolCallId,
      reason: revision.reason,
    });

    return this.deliver(item, item.draft!.mode, "Revision requested", signal, ctx);
  }
  private async deliver(
    item: Interaction,
    mode: Mode,
    notice: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    if (mode === "async") {
      ctx.ui.notify(`${notice} · ${item.request.title ?? item.id} · /answers to review`, "info");
      const details = { accepted: true, status: "pending", interaction_id: item.id };

      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    const lifetime = this.lifetime.signal;
    this.blocking.add(item.id);
    this.pi.events.emit("herdr:blocked", { active: true, label: "Waiting for answers" });

    try {
      const result = await this.open(item.id, ctx, signal);
      this.owner(lifetime);

      if (result === "submitted" && !signal?.aborted) {
        const revision = this.get(item.id).submissions.at(-1)!.revision;
        // Recorded before returning: the tool result is the answer's only delivery.
        const sent = this.mutate(item.id, { type: "sent", revision }, lifetime);

        return answerResult(answerEnvelope(sent, sent.submissions.at(-1)!));
      }

      if (result === "cancelled" || result === "closed") ctx.abort();

      const details = {
        interaction_id: item.id,
        status: result === "cancelled" ? "cancelled" : "closed",
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
    const lifetime = this.lifetime.signal;
    const signal = runSignal ? AbortSignal.any([runSignal, lifetime]) : lifetime;

    const blocking = this.blocking.has(id);

    return this.prompt(signal, async (active) => {
      this.owner(lifetime);

      try {
        return await showQuestionnaire(ctx, this.get(id), active, {
          mutate: (action) => this.mutate(id, action, lifetime),
          current: () => this.get(id),
          subscribe: (listener) => this.subscribe(listener),
          send: (revision) => this.send(id, revision, ctx, lifetime),
          blocking,
          setFlush: (flush) => {
            this.flushView = flush;
          },
          notify: (text) => ctx.ui.notify(text, "info"),
          report: (error) => this.report(error, ctx),
        });
      } finally {
        this.flushView = undefined;
      }
    });
  }
  /** Explicitly hands a submission to Pi as a user message; Pi owns it from then on. */
  send(id: string, revision: number, ctx: ExtensionContext, lifetime = this.lifetime.signal): void {
    const sent = this.mutate(id, { type: "sent", revision }, lifetime);
    const submission = sent.submissions.find((s) => s.revision === revision)!;
    this.pi.sendUserMessage(answerMessage(answerEnvelope(sent, submission)), {
      deliverAs: "steer",
    });
    ctx.ui.notify("Answers sent", "info");
  }
  async answer(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI)
      throw new Error("Questionnaires require an interactive TUI; this channel is unavailable");

    if (this.inboxOpen) return;
    this.inboxOpen = true;

    try {
      await showInbox(ctx, this, this.lifetime.signal);
    } finally {
      this.inboxOpen = false;
    }
  }
  /** Saves an open editor while its branch is still current; a failure is reported, not blocking. */
  flush(): void {
    try {
      this.flushView?.();
    } catch (error) {
      if (this.ctx) this.report(error, this.ctx);
    }
  }
  shutdown(): void {
    this.flush();
    this.lifetime.abort();
    this.listeners.clear();

    if (this.ctx) showInboxCount(this.ctx, 0);
    this.ctx = undefined;
  }
  report(cause: unknown, ctx: ExtensionContext): void {
    ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
  }
}
