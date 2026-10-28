import { randomUUID } from "node:crypto";

import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
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

const unmount = (ctx: ExtensionContext): void => {
  if (ctx.mode === "tui") {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
};

interface ActiveRun {
  baseline: string | null;
  timing: ReturnType<typeof createTiming>;
  outcome: Snapshot["outcome"];
  metrics: Metrics;
}

export class TurnRecapRuntime {
  readonly #pi: ExtensionAPI;
  readonly #configPath: string;
  readonly #lifetime = new AbortController();
  #config: RecapConfig | undefined;
  #rollingFont: RollingFont | undefined;
  #active: ActiveRun | undefined;
  readonly #recaps = new Map<string, RecapView>();
  #requestRender: (() => void) | undefined;

  constructor(pi: ExtensionAPI, configPath = getRecapConfigPath()) {
    this.#pi = pi;
    this.#configPath = configPath;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        Value.Check(RecapEntrySchema, entry.data)
      ) {
        this.#recaps.set(entry.data.runId, entry.data.recap);
      }
    }

    const lifetime = this.#lifetime.signal;

    const [config, font] = await Promise.allSettled([
      loadRecapConfig(this.#configPath),
      ctx.mode === "tui" ? loadRollingFont() : undefined,
    ]);

    if (lifetime.aborted) {
      return;
    }

    if (config.status === "fulfilled") {
      this.#config = config.value;
    } else {
      ctx.ui.notify(
        `Turn recap configuration ignored; generated recaps disabled (${this.#configPath}): ${errorText(config.reason)}`,
        "error"
      );
    }

    if (font.status === "fulfilled") {
      this.#rollingFont = font.value;
    } else {
      ctx.ui.notify(
        `Rolling numbers disabled (${getRollingFontPath()}): ${errorText(font.reason)}`,
        "error"
      );
    }
  }

  recap(runId: string): RecapView | undefined {
    return this.#recaps.get(runId);
  }

  begin(ctx: ExtensionContext): void {
    if (this.#active) {
      return;
    }

    this.#active = {
      baseline: ctx.sessionManager.getLeafId(),
      timing: createTiming(),
      outcome: "completed",
      metrics: collectMetrics([]),
    };

    this.refresh(ctx);
    this.#mount(ctx);
  }

  refresh(ctx: ExtensionContext): void {
    const active = this.#active;

    if (!active) {
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const { baseline } = active;

    const index =
      baseline === null
        ? -1
        : branch.findIndex((entry) => entry.id === baseline);

    if (baseline !== null && index === -1) {
      return;
    }

    const metrics = collectMetrics(branch, index + 1);
    const context = ctx.getContextUsage();

    if (context) {
      metrics.context = context;
    }

    active.metrics = metrics;
    this.#requestRender?.();
  }

  boundary(event: Pick<TurnEndEvent, "outcome">, ctx: ExtensionContext): void {
    if (!this.#active) {
      return;
    }

    this.#active.outcome = event.outcome;
    this.refresh(ctx);
  }

  async settled(
    event: Pick<AgentSettledEvent, "aborted">,
    ctx: ExtensionContext
  ): Promise<void> {
    const active = this.#active;

    if (!active) {
      return;
    }

    this.refresh(ctx);
    this.#active = undefined;
    unmount(ctx);

    const snapshot: Snapshot = {
      runId: randomUUID(),
      ...active.timing.read(),
      finishedAt: Date.now(),
      outcome: event.aborted ? "aborted" : active.outcome,
      metrics: active.metrics,
    };

    this.#pi.appendEntry(ENTRY_TYPE, snapshot);

    const config = this.#config;

    if (!config) {
      return;
    }

    let prompt: string | undefined;

    try {
      prompt = buildRecapPrompt(
        ctx.sessionManager.buildSessionProjection().entries,
        snapshot.outcome
      );
    } catch (error) {
      this.#save(snapshot.runId, { status: "failed", error: errorText(error) });

      return;
    }

    if (prompt === undefined) {
      return;
    }

    this.#recaps.set(snapshot.runId, { status: "generating" });
    const lifetime = this.#lifetime.signal;
    const recap = await generateRecap(ctx, config, prompt, lifetime);

    if (!lifetime.aborted) {
      this.#save(snapshot.runId, recap);
    }
  }

  shutdown(ctx: ExtensionContext): void {
    this.#lifetime.abort();
    unmount(ctx);
  }

  #save(runId: string, recap: Recap): void {
    this.#recaps.set(runId, recap);
    this.#pi.appendEntry(RECAP_ENTRY_TYPE, { runId, recap });
  }

  #mount(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.#requestRender = () => {
        tui.requestRender();
      };

      const widget = createLiveWidget(
        tui,
        theme,
        () => this.#view(),
        this.#rollingFont
      );

      return {
        ...widget,
        dispose: () => {
          widget.dispose();
          this.#requestRender = undefined;
        },
      };
    });
  }

  #view(): LiveState | undefined {
    return (
      this.#active && {
        elapsedMs: this.#active.timing.read().wallMs,
        metrics: this.#active.metrics,
      }
    );
  }
}
