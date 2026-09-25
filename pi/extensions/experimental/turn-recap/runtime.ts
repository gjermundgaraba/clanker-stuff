import { randomUUID } from "node:crypto";

import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import type { LiveState, RecapView } from "./card.js";
import type { RecapConfig } from "./config.js";
import { getRecapConfigPath, loadRecapConfig } from "./config.js";
import { buildRecapPrompt, errorText } from "./conversation.js";
import { ENTRY_TYPE, RECAP_ENTRY_TYPE, RecapEntrySchema } from "./entry.js";
import type { Recap, Snapshot } from "./entry.js";
import { getRollingFontPath, loadRollingFont } from "./font.js";
import type { RollingFont } from "./font.js";
import { collectMetrics } from "./metrics.js";
import type { Metrics } from "./metrics.js";
import { generateRecap } from "./recap.js";
import { createTiming } from "./timing.js";
import { createLiveWidget } from "./widget.js";

const WIDGET_KEY = "turn-recap";

interface SessionState {
  config: RecapConfig | undefined;
  rollingFont: RollingFont | undefined;
}

interface ActiveRun {
  baseline: string | null;
  timing: ReturnType<typeof createTiming>;
  signal: AbortSignal | undefined;
  contextStart: number | null;
  outcome: Snapshot["outcome"];
  metrics: Metrics;
}

class TurnRecapRuntime {
  readonly #pi: ExtensionAPI;
  readonly #configPath: string;
  #session: SessionState | undefined;
  #active: ActiveRun | undefined;
  /** Recaps by run ID, from saved entries plus those being generated. */
  #recaps = new Map<string, RecapView>();
  /** Recap requests in flight; several can overlap later runs. */
  #pending = new Set<AbortController>();
  #requestRender: (() => void) | undefined;
  #promptActive = false;
  #asyncPrompt = false;

  constructor(pi: ExtensionAPI, configPath: string) {
    this.#pi = pi;
    this.#configPath = configPath;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.#reset(ctx);

    // Keyed by run ID, so recaps on other branches are harmless and navigation needs no rebuild.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        Value.Check(RecapEntrySchema, entry.data)
      )
        this.#recaps.set(entry.data.runId, entry.data.recap);
    }

    const session: SessionState = { config: undefined, rollingFont: undefined };
    this.#session = session;

    // Independent loads: a broken config never disables animation, or vice versa.
    const [config, font] = await Promise.allSettled([
      loadRecapConfig(this.#configPath),
      ctx.mode === "tui" ? loadRollingFont() : undefined,
    ]);

    if (this.#session !== session) return;

    if (config.status === "fulfilled") session.config = config.value;
    else
      ctx.ui.notify(
        `Turn recap configuration ignored; generated recaps disabled (${this.#configPath}): ${errorText(config.reason)}`,
        "error",
      );

    if (font.status === "fulfilled") session.rollingFont = font.value;
    else
      ctx.ui.notify(
        `Rolling numbers disabled (${getRollingFontPath()}): ${errorText(font.reason)}`,
        "error",
      );
  }

  view(): LiveState | undefined {
    return (
      this.#active && {
        activeMs: this.#active.timing.read().activeMs,
        paused: this.#promptActive,
        metrics: this.#active.metrics,
      }
    );
  }

  recap(runId: string): RecapView | undefined {
    return this.#recaps.get(runId);
  }

  begin(ctx: ExtensionContext): void {
    // Retries and queued continuations can emit multiple starts before settling.
    if (this.#active) {
      this.#active.signal = ctx.signal;

      return;
    }

    this.#active = {
      baseline: ctx.sessionManager.getLeafId(),
      timing: createTiming(this.#promptActive),
      signal: ctx.signal,
      contextStart: null,
      outcome: "completed",
      metrics: collectMetrics([]),
    };

    // Measures the starting context, so the first frame already reads +0.
    this.refresh(ctx);
    this.#mount(ctx);
  }

  refresh(ctx: ExtensionContext): void {
    const active = this.#active;

    if (!active) return;
    const branch = ctx.sessionManager.getBranch();
    const baseline = active.baseline;
    const index = baseline === null ? -1 : branch.findIndex((entry) => entry.id === baseline);

    // A replaced branch must never be charged to the abandoned run.
    if (baseline !== null && index === -1) return;
    const metrics = collectMetrics(branch.slice(index + 1));
    const context = ctx.getContextUsage();

    if (context) {
      // After compaction Pi knows no size until the next response; the first known size stands in.
      active.contextStart ??= context.tokens;
      metrics.context = { ...context, startTokens: active.contextStart };
    }

    active.metrics = metrics;
    this.#requestRender?.();
  }

  boundary(event: Pick<AgentBeforeSettleEvent, "outcome">, ctx: ExtensionContext): void {
    if (!this.#active) return;
    this.#active.outcome = event.outcome;
    this.#active.signal = ctx.signal ?? this.#active.signal;
    this.refresh(ctx);
  }

  async settled(ctx: ExtensionContext): Promise<void> {
    const config = this.#session?.config;
    const active = this.#active;

    if (!this.#session || !active) return;
    this.refresh(ctx);
    this.#active = undefined;
    this.#unmount(ctx);

    const snapshot: Snapshot = {
      runId: randomUUID(),
      ...active.timing.read(),
      finishedAt: Date.now(),
      outcome: active.signal?.aborted ? "aborted" : active.outcome,
      metrics: active.metrics,
    };

    this.#pi.appendEntry(ENTRY_TYPE, snapshot);

    if (!config) return;
    let prompt: string | undefined;

    try {
      prompt = buildRecapPrompt(
        ctx.sessionManager.buildSessionProjection().entries,
        snapshot.outcome,
      );
    } catch (error) {
      this.#save(snapshot.runId, { status: "failed", error: errorText(error) });

      return;
    }

    if (prompt === undefined) return;

    // Pi draws the new card on a later frame, so it already sees this.
    this.#recaps.set(snapshot.runId, { status: "generating" });
    const controller = new AbortController();
    this.#pending.add(controller);

    try {
      const recap = await generateRecap(ctx, config, prompt, controller.signal);

      // Only shutdown aborts; later runs and tree navigation let the recap finish.
      if (!controller.signal.aborted) this.#save(snapshot.runId, recap);
    } finally {
      this.#pending.delete(controller);
    }
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

  shutdown(ctx: ExtensionContext): void {
    this.#reset(ctx);
  }

  #reset(ctx: ExtensionContext): void {
    for (const controller of this.#pending) controller.abort();
    this.#pending.clear();
    this.#recaps.clear();
    this.#active = undefined;
    this.#session = undefined;
    this.#promptActive = false;
    this.#asyncPrompt = false;
    this.#unmount(ctx);
  }

  /** Writing any entry makes Pi redraw the transcript, so the card picks up its recap. */
  #save(runId: string, recap: Recap): void {
    this.#recaps.set(runId, recap);
    this.#pi.appendEntry(RECAP_ENTRY_TYPE, { runId, recap });
  }

  /**
   * A fresh widget per run, so rolling history never spans runs. A run that starts
   * while the font is still loading keeps ordinary digits.
   */
  #mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;

    // Pi disposes a replaced widget before building its successor.
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.#requestRender = () => tui.requestRender();

      const widget = createLiveWidget(tui, theme, () => this.view(), this.#session?.rollingFont);

      return {
        ...widget,
        dispose: () => {
          widget.dispose();
          this.#requestRender = undefined;
        },
      };
    });
  }

  #unmount(ctx: ExtensionContext): void {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

export const createTurnRecapRuntime = (
  pi: ExtensionAPI,
  configPath = getRecapConfigPath(),
): TurnRecapRuntime => new TurnRecapRuntime(pi, configPath);
