import { acquireEditorHost, currentEditorHost } from "@clanker-stuff/editor";
import type { EditorHost } from "@clanker-stuff/editor";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
  DEFAULT_CONFIG,
  formatFooterConfig,
  parseFooterConfig,
  placedIds,
  STATUS_PREFIX,
  STATUSES_ID,
} from "./config.js";
import type { FooterConfig, FooterConfigStore } from "./config.js";
import type { GitDetails, readGitDetails } from "./git.js";
import { layoutFooter, renderBorder, renderBuiltin, statusWidgets } from "./layout.js";
import type { FooterTheme, LiveWidget } from "./layout.js";
import { buildBuiltinWidgets } from "./widgets.js";
import type { BuiltinWidget } from "./widgets.js";

const TICK_MS = 60_000;

const RETAINED_ERRORS = 20;

interface Runtime {
  ctx: ExtensionContext;
  config: FooterConfig;
  /** Why the file's layout was not used; cleared once a layout is saved. */
  loadError: string | undefined;
  footerData: ReadonlyFooterDataProvider | undefined;
  requestRender: () => void;
  details: GitDetails | undefined;
  gitGeneration: number;
  builtins: { key: string; widgets: Map<string, BuiltinWidget> } | undefined;
  truncated: string[];
  errors: string[];
  border: { host: EditorHost; release: () => void } | undefined;
  timer: ReturnType<typeof setInterval>;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const placement = (config: FooterConfig, id: string): string => {
  if (config.hidden.includes(id)) return "hidden";

  const row = config.rows.findIndex(({ left, right }) => left.includes(id) || right.includes(id));

  if (row !== -1)
    return `row ${row + 1} ${config.rows[row]?.left.includes(id) === true ? "left" : "right"}`;

  if (config.border.includes(id)) return "border";

  return id.startsWith(STATUS_PREFIX) && placedIds(config).includes(STATUSES_ID)
    ? STATUSES_ID
    : "not placed";
};

/** The layout as drawn: unless Pi still shows the shared editor, border statuses fall back to `footer.statuses`. */
const drawn = (active: Runtime): FooterConfig =>
  active.border !== undefined && currentEditorHost(active.ctx) === active.border.host
    ? active.config
    : { ...active.config, border: [] };

export const createFooterHost = (
  pi: ExtensionAPI,
  store: FooterConfigStore,
  readGit: typeof readGitDetails,
) => {
  let runtime: Runtime | undefined;
  let generation = 0;

  const addError = (active: Runtime, error: unknown): void => {
    const text = describe(error);

    if (active.errors.at(-1) === text) return;

    active.errors.push(text);
    active.errors.splice(0, Math.max(0, active.errors.length - RETAINED_ERRORS));
  };

  /** Recomputed only when what they show can have changed, like Pi's own footer. */
  const builtins = (active: Runtime): Map<string, BuiltinWidget> => {
    const { ctx } = active;
    const branch = active.footerData?.getGitBranch() ?? null;
    const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
    const now = Date.now();

    // Every session append moves the leaf; the minute drives the elapsed-time display.
    const key = JSON.stringify([
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getLeafId(),
      ctx.model?.provider,
      ctx.model?.id,
      thinkingLevel,
      branch,
      active.details,
      Math.floor(now / TICK_MS),
    ]);

    if (active.builtins?.key !== key) {
      active.builtins = {
        key,
        widgets: buildBuiltinWidgets(ctx, { branch, details: active.details, now, thinkingLevel }),
      };
    }

    return active.builtins.widgets;
  };

  /** Every built-in is always in the map, empty or not, so it names the known IDs. */
  const configWarnings = (active: Runtime): string[] => {
    const { config, loadError } = active;
    const known = builtins(active);

    const unknown = [
      ...new Set(
        placedIds(config).filter(
          (id) => id !== STATUSES_ID && !id.startsWith(STATUS_PREFIX) && !known.has(id),
        ),
      ),
    ];

    return [
      ...(loadError === undefined ? [] : [`${loadError}; using the default footer layout`]),
      ...(unknown.length === 0 ? [] : [`Footer ignores unknown widget IDs: ${unknown.join(", ")}`]),
    ];
  };

  const statuses = (active: Runtime): Map<string, LiveWidget> =>
    statusWidgets(active.footerData?.getExtensionStatuses() ?? new Map<string, string>());

  const liveWidgets = (active: Runtime, theme: FooterTheme): Map<string, LiveWidget> => {
    const live = new Map<string, LiveWidget>();

    for (const widget of builtins(active).values()) {
      const text = renderBuiltin(widget, active.config.iconFamily, theme);
      live.set(
        widget.id,
        widget.truncate === undefined ? { text } : { text, truncate: widget.truncate },
      );
    }

    for (const [id, widget] of statuses(active)) live.set(id, widget);

    return live;
  };

  const refreshGit = (active: Runtime): void => {
    const current = ++active.gitGeneration;

    // Pi's footer data names the branch; only the change counts need a repository scan.
    if (
      !placedIds(active.config).includes("footer.git.details") ||
      (active.footerData?.getGitBranch() ?? null) === null
    ) {
      active.details = undefined;

      return;
    }

    void readGit(pi, active.ctx.cwd).then(
      (details) => {
        if (runtime !== active || current !== active.gitGeneration) return;

        active.details = details;
        active.requestRender();
      },
      (error: unknown) => {
        if (runtime !== active || current !== active.gitGeneration) return;

        active.details = undefined;
        addError(active, error);
        active.requestRender();
      },
    );
  };

  const install = (active: Runtime): void => {
    active.ctx.ui.setFooter((tui, theme, footerData) => {
      active.footerData = footerData;
      active.requestRender = () => tui.requestRender();

      const unsubscribe = footerData.onBranchChange(() => {
        if (runtime !== active) return;

        active.requestRender();
        refreshGit(active);
      });

      return {
        dispose() {
          unsubscribe();
        },
        invalidate() {},
        render(width: number): string[] {
          if (runtime !== active) return [];

          try {
            const layout = layoutFooter(drawn(active), liveWidgets(active, theme), width, theme);
            active.truncated = layout.truncated;

            return layout.lines;
          } catch (error) {
            addError(active, error);

            return [];
          }
        },
      };
    });
  };

  /** Border widgets render into Pi's editor top border through the shared editor. */
  const syncBorder = (active: Runtime): void => {
    if (active.config.border.length === 0) {
      active.border?.release();
      active.border = undefined;

      return;
    }

    if (active.border !== undefined) return;
    const host = acquireEditorHost(active.ctx);

    if (host === undefined) return;

    const release = host.contribute("border", {
      render: (line, width, color) => {
        if (runtime !== active) return line;

        const { theme } = active.ctx.ui;
        const live = liveWidgets(active, theme);
        const entries = active.config.border.flatMap((id) => live.get(id)?.text ?? []);

        return renderBorder(line, width, entries, theme, color);
      },
    });

    active.border = { host, release };
  };

  const apply = (active: Runtime, config: FooterConfig): void => {
    active.config = config;
    active.loadError = undefined;
    syncBorder(active);
    refreshGit(active);
    active.requestRender();
  };

  const save = async (
    active: Runtime,
    ctx: ExtensionCommandContext,
    config: FooterConfig,
  ): Promise<void> => {
    try {
      await store.save(config);
    } catch (error) {
      ctx.ui.notify(`Footer layout was not saved: ${describe(error)}`, "error");

      return;
    }

    if (runtime !== active) return;

    apply(active, config);
    const [warning] = configWarnings(active);
    ctx.ui.notify(warning ?? `Saved ${store.path}`, warning === undefined ? "info" : "warning");
  };

  const edit = async (active: Runtime, ctx: ExtensionCommandContext): Promise<void> => {
    const loaded = await store.load();
    let text = loaded.text ?? formatFooterConfig(loaded.config);

    for (;;) {
      const edited = await ctx.ui.editor("footer.json", text);

      if (edited === undefined || runtime !== active) return;

      try {
        await save(active, ctx, parseFooterConfig(edited));

        return;
      } catch (error) {
        ctx.ui.notify(`Invalid footer config: ${describe(error)}`, "error");
        text = edited;
      }
    }
  };

  const inspect = (active: Runtime, ctx: ExtensionContext): string[] => {
    const live = liveWidgets(active, ctx.ui.theme);
    const truncated = new Set(active.truncated);
    const ids = [...new Set([...live.keys(), ...placedIds(active.config)])].toSorted();

    return [
      `config: ${store.path}`,
      ...configWarnings(active),
      ...ids.map((id) => {
        const text = live.get(id)?.text;

        const state =
          text === undefined ? " · not present" : truncated.has(id) ? " · truncated" : "";

        return `${id} · ${placement(drawn(active), id)}${state}${text ? `: ${stripTerminalSequences(text)}` : ""}`;
      }),
      ...(active.errors.length === 0
        ? ["errors: none"]
        : active.errors.map((error) => `error: ${error}`)),
    ];
  };

  const stop = (): void => {
    const active = runtime;

    if (!active) return;

    // Pi removes the custom footer itself after session_shutdown handlers run.
    runtime = undefined;
    active.gitGeneration += 1;
    clearInterval(active.timer);
    active.border?.release();
  };

  return {
    command: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const active = runtime;

      if (ctx.mode !== "tui" || !active) {
        ctx.ui.notify("/footer requires an active TUI session", "info");

        return;
      }

      switch (args.trim()) {
        case "": {
          await edit(active, ctx);

          return;
        }

        case "reset": {
          await save(active, ctx, DEFAULT_CONFIG);

          return;
        }

        case "inspect": {
          ctx.ui.notify(inspect(active, ctx).join("\n"), "info");

          return;
        }

        default: {
          ctx.ui.notify("Usage: /footer [reset|inspect]", "info");
        }
      }
    },
    refreshGit: (): void => {
      if (runtime) refreshGit(runtime);
    },
    requestRender: (): void => {
      runtime?.requestRender();
    },
    shutdown: (): void => {
      generation += 1;
      stop();
    },
    start: async (ctx: ExtensionContext): Promise<void> => {
      const current = ++generation;
      stop();

      if (ctx.mode !== "tui") return;

      const loaded = await store.load();

      if (current !== generation) return;

      const active: Runtime = {
        builtins: undefined,
        config: loaded.config,
        ctx,
        details: undefined,
        errors: [],
        footerData: undefined,
        gitGeneration: 0,
        loadError: loaded.error,
        border: undefined,
        requestRender: () => {},
        timer: setInterval(() => active.requestRender(), TICK_MS),
        truncated: [],
      };

      active.timer.unref();
      runtime = active;

      for (const warning of configWarnings(active)) ctx.ui.notify(warning, "warning");

      install(active);
      syncBorder(active);
      refreshGit(active);
    },
  };
};
