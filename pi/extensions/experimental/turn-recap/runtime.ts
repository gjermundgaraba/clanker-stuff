import { randomUUID } from "node:crypto";

import { BREATHING_DOT_INTERVAL_MS } from "@clanker-stuff/pi-motion";
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { renderCard } from "./card.js";
import type { CardState } from "./card.js";
import type { RecapConfig } from "./config.js";
import { getRecapConfigPath, loadRecapConfig } from "./config.js";
import { buildRecapPrompt, sanitizeRecapText } from "./conversation.js";
import { ENTRY_TYPE, restoreSnapshots } from "./entry.js";
import type { Recap, Snapshot } from "./entry.js";
import { collectMetrics } from "./metrics.js";
import { generateRecap } from "./recap.js";
import { createTiming } from "./timing.js";

interface SessionState {
  id: string;
  config: RecapConfig | undefined;
  configError: string | undefined;
}

interface ActiveRun {
  baseline: string | null;
  timing: ReturnType<typeof createTiming>;
  signal: AbortSignal | undefined;
}

class TurnRecapRuntime {
  readonly #pi: ExtensionAPI;
  readonly #configPath: string;
  #session: SessionState | undefined;
  #current: Snapshot | undefined;
  #previousRecap: string | undefined;
  #active: ActiveRun | undefined;
  #request: AbortController | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #requestRender: (() => void) | undefined;
  #expanded = false;
  #promptActive = false;
  #asyncPrompt = false;

  constructor(pi: ExtensionAPI, configPath: string) {
    this.#pi = pi;
    this.#configPath = configPath;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.dispose(ctx);

    const session: SessionState = {
      id: ctx.sessionManager.getSessionId(),
      config: undefined,
      configError: undefined,
    };

    this.#session = session;
    this.restore(ctx);

    if (ctx.mode === "tui") {
      ctx.ui.setWidget("turn-recap", (tui, theme) => {
        this.#requestRender = () => tui.requestRender();

        return {
          render: (width) => renderCard(this.view(), width, theme, tui.terminal.rows),
          invalidate() {},
          dispose: () => {
            this.#requestRender = undefined;
          },
        };
      });
    }

    try {
      const config = await loadRecapConfig(this.#configPath);

      if (this.#session === session) session.config = config;
    } catch (error) {
      if (this.#session !== session) return;
      session.configError = sanitizeRecapText(
        error instanceof Error ? error.message : String(error),
      );
      ctx.ui.notify(
        sanitizeRecapText(`Turn recap text disabled (${this.#configPath}): ${session.configError}`),
        "error",
      );
    }
  }

  view(): CardState {
    return {
      snapshot:
        this.#current && this.#active
          ? { ...this.#current, ...this.#active.timing.read() }
          : this.#current,
      previousRecap: this.#previousRecap,
      running: this.#active !== undefined,
      waiting: this.#promptActive,
      expanded: this.#expanded,
    };
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
    this.#requestRender?.();
  }

  begin(ctx: ExtensionContext): void {
    this.#cancelRequest();

    // Retries and queued continuations can emit multiple starts before settling.
    if (this.#active) {
      this.#active.signal = ctx.signal;

      return;
    }

    if (this.#current?.recap.status === "ready") this.#previousRecap = this.#current.recap.text;
    const timing = createTiming(this.#promptActive);
    this.#active = { baseline: ctx.sessionManager.getLeafId(), timing, signal: ctx.signal };
    this.#current = {
      runId: randomUUID(),
      ...timing.read(),
      finishedAt: Date.now(),
      outcome: "completed",
      metrics: collectMetrics([]),
      recap: { status: "off" },
    };

    if (ctx.mode === "tui") {
      this.#interval = setInterval(() => this.#requestRender?.(), BREATHING_DOT_INTERVAL_MS);
    }

    this.#requestRender?.();
  }

  refresh(ctx: ExtensionContext): void {
    if (!this.#active || !this.#current) return;
    const branch = ctx.sessionManager.getBranch();
    const baseline = this.#active.baseline;
    const index = baseline === null ? -1 : branch.findIndex((entry) => entry.id === baseline);

    // A replaced branch must never be charged to the abandoned run.
    if (baseline !== null && index === -1) return;
    const metrics = collectMetrics(branch.slice(index + 1));
    const context = ctx.getContextUsage();

    if (context) metrics.context = context;
    this.#current = { ...this.#current, metrics };
    this.#requestRender?.();
  }

  boundary(event: Pick<AgentBeforeSettleEvent, "outcome">, ctx: ExtensionContext): void {
    if (!this.#current || !this.#active) return;
    this.#current = { ...this.#current, outcome: event.outcome };
    this.#active.signal = ctx.signal ?? this.#active.signal;
    this.refresh(ctx);
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    const session = this.#session;

    if (!session || !this.#active || !this.#current) return;
    this.refresh(ctx);
    const outcome = this.#active.signal?.aborted ? "aborted" : this.#current.outcome;

    const snapshot: Snapshot = {
      ...this.#current,
      ...this.#active.timing.read(),
      finishedAt: Date.now(),
      outcome,
      recap:
        session.configError !== undefined
          ? { status: "failed", error: session.configError }
          : session.config
            ? { status: "pending" }
            : { status: "off" },
    };

    this.#stopClock();
    this.#current = snapshot;
    this.#pi.appendEntry(ENTRY_TYPE, snapshot);
    this.#requestRender?.();

    if (session.config) await this.#generate(ctx, session, session.config, snapshot);
  }

  setAsyncPrompt(event: unknown): void {
    this.#asyncPrompt =
      typeof event === "object" && event !== null && "active" in event && event.active === true;
  }

  pause(): void {
    if (this.#asyncPrompt) return;
    this.#promptActive = true;
    this.#active?.timing.pause();
    this.#requestRender?.();
  }

  resume(): void {
    if (!this.#promptActive) return;
    this.#promptActive = false;
    this.#active?.timing.resume();
    this.#requestRender?.();
  }

  restore(ctx: ExtensionContext): void {
    this.#cancelRequest();
    this.#stopClock();
    const restored = restoreSnapshots(ctx.sessionManager.getBranch());
    this.#current = restored.current;
    this.#previousRecap = restored.previousRecap;
    this.#requestRender?.();
  }

  dispose(ctx: ExtensionContext): void {
    this.#cancelRequest();
    this.#stopClock();
    this.#session = undefined;
    this.#current = undefined;
    this.#previousRecap = undefined;
    this.#promptActive = false;
    this.#asyncPrompt = false;

    if (ctx.mode === "tui") ctx.ui.setWidget("turn-recap", undefined);
    this.#requestRender = undefined;
  }

  #stopClock(): void {
    clearInterval(this.#interval);
    this.#interval = undefined;
    this.#active = undefined;
  }

  #cancelRequest(): void {
    const request = this.#request;
    this.#request = undefined;
    request?.abort();

    if (this.#current?.recap.status === "pending") {
      this.#current = { ...this.#current, recap: { status: "cancelled" } };
    }
  }

  async #generate(
    ctx: ExtensionContext,
    session: SessionState,
    config: RecapConfig,
    snapshot: Snapshot,
  ): Promise<void> {
    const controller = new AbortController();
    this.#request = controller;
    let recap: Recap;

    try {
      const prompt = buildRecapPrompt(
        ctx.sessionManager.buildSessionProjection().entries,
        snapshot.outcome,
      );

      recap =
        prompt === undefined
          ? { status: "off" }
          : await generateRecap(ctx, config, prompt, controller.signal);

      if (this.#request !== controller || this.#session !== session) return;

      if (
        ctx.sessionManager.getSessionId() !== session.id ||
        !ctx.isIdle() ||
        buildRecapPrompt(ctx.sessionManager.buildSessionProjection().entries, snapshot.outcome) !==
          prompt
      )
        recap = { status: "cancelled" };
    } catch (error) {
      recap = {
        status: "failed",
        error: sanitizeRecapText(error instanceof Error ? error.message : String(error)),
      };
    }

    if (this.#request !== controller || this.#session !== session) return;
    this.#request = undefined;
    this.#current = { ...snapshot, recap };
    this.#pi.appendEntry(ENTRY_TYPE, this.#current);
    this.#requestRender?.();
  }
}

export const createTurnRecapRuntime = (
  pi: ExtensionAPI,
  configPath = getRecapConfigPath(),
): TurnRecapRuntime => new TurnRecapRuntime(pi, configPath);
