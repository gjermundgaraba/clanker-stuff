/* oxlint-disable eslint/no-use-before-define, eslint/no-plusplus, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/consistent-function-scoping, unicorn/no-useless-collection-argument -- lifecycle helpers stay adjacent to their state */

import { randomUUID } from "node:crypto";

import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  isFooterReadyRequestMessage,
} from "@clanker-stuff/footer-protocol";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";

import { cloneFooterConfig, createFooterConfigStore } from "./config.js";
import type { FooterConfig, LoadedFooterConfig } from "./config.js";
import type { GitStatus } from "./git.js";
import { readGitStatus, sameGitStatus } from "./git.js";
import { renderFooterState } from "./layout.js";
import type { FooterLayoutResult, FooterRenderState } from "./layout.js";
import { validateFooterWidgetMessage } from "./protocol-validation.js";
import { summary } from "./summary.js";
import { buildBuiltinWidgets, collectSessionTotals } from "./widgets.js";
import type { LiveWidget, SessionTotals } from "./widgets.js";

const SESSION_TICK_MS = 60_000;
const RETAINED_COLLECTOR_ERRORS = 50;
const MAX_RICH_WIDGETS = 256;
const MAX_PROTOCOL_ERRORS = 50;

export interface ProtocolErrorRecord {
  class: string;
  message: string;
  timestamp: number;
}

export type FooterLifecycleState =
  | "starting"
  | "active"
  | "disabled"
  | "replaced"
  | "stopped";

export interface HostRuntime {
  builtins: Map<string, LiveWidget>;
  collectorErrors: string[];
  config: FooterConfig;
  configLoaded: LoadedFooterConfig;
  context: ExtensionContext;
  footerData?: ReadonlyFooterDataProvider;
  git: GitStatus | null;
  gitGeneration: number;
  instanceId: string;
  lastLayout?: FooterLayoutResult;
  lifecycle: FooterLifecycleState;
  notifiedProtocolErrors: Set<string>;
  protocolErrors: ProtocolErrorRecord[];
  requestRender?: () => void;
  rich: Map<string, LiveWidget>;
  session: SessionTotals;
}

const sessionCanRender = (config: FooterConfig): boolean =>
  config.enabled &&
  config.widgets["footer.session"]?.enabled !== false &&
  config.rows.some((row) =>
    [row.left, row.center, row.right].some((group) =>
      group.includes("footer.session")
    )
  );

const gitCanRender = (config: FooterConfig): boolean =>
  config.enabled &&
  ["footer.git", "footer.git.details"].some(
    (id) =>
      config.widgets[id]?.enabled !== false &&
      config.rows.some((row) =>
        [row.left, row.center, row.right].some((group) => group.includes(id))
      )
  );

export const createFooterHost = (pi: ExtensionAPI) => {
  const configStore = createFooterConfigStore();
  let runtime: HostRuntime | undefined;
  let branchUnsubscribe: (() => void) | undefined;
  let protocolUnsubscribe: (() => void) | undefined;
  let readyRequestUnsubscribe: (() => void) | undefined;
  let sessionTimer: ReturnType<typeof setInterval> | undefined;
  let startGeneration = 0;

  const addCollectorError = (active: HostRuntime, value: unknown): void => {
    const message = summary(
      value instanceof Error ? value.message : String(value)
    );
    if (active.collectorErrors.at(-1) !== message) {
      active.collectorErrors.push(message);
      active.collectorErrors.splice(
        0,
        Math.max(0, active.collectorErrors.length - RETAINED_COLLECTOR_ERRORS)
      );
    }
  };

  const recordProtocolError = (
    active: HostRuntime,
    errorClass: string,
    message: string
  ): void => {
    active.protocolErrors.unshift({
      class: errorClass,
      message: summary(message),
      timestamp: Date.now(),
    });
    active.protocolErrors.length = Math.min(
      active.protocolErrors.length,
      MAX_PROTOCOL_ERRORS
    );
    if (!active.notifiedProtocolErrors.has(errorClass)) {
      active.notifiedProtocolErrors.add(errorClass);
      active.context.ui.notify(
        `Footer rejected a ${errorClass} protocol message; run /footer doctor`,
        "warning"
      );
    }
  };

  const rebuildBuiltins = (active: HostRuntime): void => {
    try {
      active.builtins = buildBuiltinWidgets(active.context, {
        git: active.git,
        now: Date.now(),
        session: active.session,
        thinkingLevel: active.context.thinkingLevel ?? pi.getThinkingLevel(),
      });
    } catch (error) {
      addCollectorError(active, error);
    }
    active.requestRender?.();
  };

  const refreshSessionTotals = (active: HostRuntime): void => {
    if (!sessionCanRender(active.config)) {
      return;
    }
    try {
      active.session = collectSessionTotals(active.context);
    } catch (error) {
      addCollectorError(active, error);
    }
    rebuildBuiltins(active);
  };

  const refreshGit = (active: HostRuntime): void => {
    const generation = ++active.gitGeneration;
    if (!gitCanRender(active.config)) {
      return;
    }
    const { cwd } = active.context;
    void readGitStatus(pi, cwd)
      .then((status) => {
        if (
          runtime !== active ||
          generation !== active.gitGeneration ||
          active.lifecycle === "stopped"
        ) {
          return;
        }
        if (!sameGitStatus(active.git, status)) {
          active.git = status;
          rebuildBuiltins(active);
        }
      })
      .catch((error: unknown) => {
        if (runtime === active && generation === active.gitGeneration) {
          addCollectorError(active, error);
        }
      });
  };

  const renderState = (active: HostRuntime): FooterRenderState => ({
    builtins: active.builtins,
    config: active.config,
    nativeStatuses:
      active.footerData?.getExtensionStatuses() ?? new Map<string, string>(),
    rich: active.rich,
  });

  const disposeBranchSubscription = (): void => {
    branchUnsubscribe?.();
    branchUnsubscribe = undefined;
  };

  const installFooter = (active: HostRuntime): void => {
    if (active.lifecycle === "replaced" || active.lifecycle === "stopped") {
      return;
    }
    active.lifecycle = "active";
    active.context.ui.setFooter((tui, theme, footerData) => {
      disposeBranchSubscription();
      active.footerData = footerData;
      active.requestRender = () => {
        tui.requestRender();
      };
      branchUnsubscribe = footerData.onBranchChange(() => {
        refreshGit(active);
      });
      return {
        dispose() {
          disposeBranchSubscription();
          active.requestRender = undefined;
          if (runtime === active && active.lifecycle === "active") {
            active.lifecycle = "replaced";
            active.context.ui.notify(
              "Footer was replaced by another extension; run /footer doctor",
              "warning"
            );
          }
          syncTimer(active);
        },
        invalidate() {
          tui.requestRender();
        },
        render(width: number): string[] {
          try {
            active.lastLayout = renderFooterState(
              renderState(active),
              width,
              theme
            );
            for (const error of active.lastLayout.widgetErrors) {
              addCollectorError(
                active,
                `widget ${summary(error.id)}: ${summary(error.message)}`
              );
            }
            return active.lastLayout.lines;
          } catch (error) {
            active.lastLayout = undefined;
            addCollectorError(active, `render: ${String(error)}`);
            return [];
          }
        },
      };
    });
    syncTimer(active);
  };

  const disableFooter = (active: HostRuntime): void => {
    if (active.lifecycle !== "active") {
      return;
    }
    active.lifecycle = "disabled";
    disposeBranchSubscription();
    active.context.ui.setFooter(undefined);
    active.requestRender = undefined;
    syncTimer(active);
  };

  const applyConfig = (active: HostRuntime, config: FooterConfig): void => {
    const gitWasRenderable = gitCanRender(active.config);
    const sessionWasRenderable = sessionCanRender(active.config);
    active.config = cloneFooterConfig(config);
    if (gitWasRenderable !== gitCanRender(active.config)) {
      refreshGit(active);
    }
    if (!sessionWasRenderable && sessionCanRender(active.config)) {
      refreshSessionTotals(active);
    }
    if (active.lifecycle === "replaced" || active.lifecycle === "stopped") {
      return;
    }
    if (config.enabled) {
      if (active.lifecycle === "active") {
        active.requestRender?.();
      } else {
        installFooter(active);
      }
    } else {
      disableFooter(active);
    }
    syncTimer(active);
  };

  const stopTimer = (): void => {
    if (sessionTimer !== undefined) {
      clearInterval(sessionTimer);
      sessionTimer = undefined;
    }
  };

  const startTimer = (active: HostRuntime): void => {
    if (sessionTimer !== undefined) {
      return;
    }
    sessionTimer = setInterval(() => {
      if (
        runtime === active &&
        active.lifecycle === "active" &&
        sessionCanRender(active.config)
      ) {
        rebuildBuiltins(active);
      }
    }, SESSION_TICK_MS);
  };

  const syncTimer = (active: HostRuntime): void => {
    if (
      runtime === active &&
      active.context.mode === "tui" &&
      active.lifecycle === "active" &&
      sessionCanRender(active.config)
    ) {
      startTimer(active);
    } else {
      stopTimer();
    }
  };

  const stopRuntime = (): void => {
    const active = runtime;
    if (!active) {
      return;
    }
    const ownedFooter = active.lifecycle === "active";
    active.lifecycle = "stopped";
    active.gitGeneration += 1;
    stopTimer();
    disposeBranchSubscription();
    if (ownedFooter) {
      active.context.ui.setFooter(undefined);
    }
    active.requestRender = undefined;
    active.footerData = undefined;
    active.rich.clear();
    active.builtins.clear();
    runtime = undefined;
  };

  const handleWidgetMessage = (value: unknown): void => {
    const active = runtime;
    if (!active || active.lifecycle === "stopped") {
      return;
    }
    const validated = validateFooterWidgetMessage(value);
    if (!validated.ok) {
      recordProtocolError(active, validated.class, validated.message);
      return;
    }
    if (validated.value.instanceId !== active.instanceId) {
      return;
    }
    if (validated.value.type === "remove") {
      active.rich.delete(validated.value.id);
      active.requestRender?.();
      return;
    }
    const { id } = validated.value.widget;
    if (!active.rich.has(id) && active.rich.size >= MAX_RICH_WIDGETS) {
      recordProtocolError(
        active,
        "capacity",
        `rich widget limit ${MAX_RICH_WIDGETS} reached`
      );
      return;
    }
    active.rich.set(id, {
      snapshot: validated.value.widget,
      source: "rich",
    });
    active.requestRender?.();
  };

  const emitReady = (active: HostRuntime): void => {
    pi.events.emit(FOOTER_READY_EVENT, {
      instanceId: active.instanceId,
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "ready",
    });
  };

  const listenForProtocolMessages = (): void => {
    protocolUnsubscribe ??= pi.events.on(
      FOOTER_WIDGET_EVENT,
      handleWidgetMessage
    );
    readyRequestUnsubscribe ??= pi.events.on(
      FOOTER_READY_REQUEST_EVENT,
      (value) => {
        if (runtime !== undefined && isFooterReadyRequestMessage(value)) {
          emitReady(runtime);
        }
      }
    );
  };

  const updateContext = (ctx: ExtensionContext): HostRuntime | undefined => {
    if (runtime) {
      runtime.context = ctx;
    }
    return runtime;
  };

  return {
    refresh: (ctx: ExtensionContext): void => {
      const active = updateContext(ctx);
      if (active) {
        rebuildBuiltins(active);
      }
    },
    refreshTotals: (ctx: ExtensionContext): void => {
      const active = updateContext(ctx);
      if (active) {
        refreshSessionTotals(active);
      }
    },
    runCommand: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const active = runtime;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/footer requires TUI mode", "info");
        return;
      }
      if (!active) {
        ctx.ui.notify("Footer host is not running", "warning");
        return;
      }
      active.context = ctx;
      const command = args.trim();
      if (command !== "" && command !== "inspect" && command !== "doctor") {
        ctx.ui.notify("usage: /footer [inspect|doctor]", "info");
        return;
      }
      const [
        { doctorLines, editorWidgets, inspectLines },
        { showFooterEditor, showFooterTextView },
      ] = await Promise.all([import("./diagnostics.js"), import("./ui.js")]);
      if (command === "inspect") {
        await showFooterTextView(ctx, "Footer inspect", () =>
          inspectLines(active, Date.now())
        );
        return;
      }
      if (command === "doctor") {
        await showFooterTextView(ctx, "Footer doctor", () =>
          doctorLines(active, configStore.path)
        );
        return;
      }

      const loaded = await configStore.load();
      active.configLoaded = loaded;
      applyConfig(active, loaded.config);
      const widgets = editorWidgets(active);
      await showFooterEditor(ctx, {
        loaded,
        onPreview: (config) => {
          applyConfig(active, config);
        },
        onSave: async (config) => {
          await configStore.save(config);
          active.configLoaded = { config };
          applyConfig(active, config);
        },
        renderPreview: (config, width) => {
          try {
            return renderFooterState(
              { ...renderState(active), config },
              width,
              ctx.ui.theme
            ).lines;
          } catch {
            return [];
          }
        },
        widgets,
      });
    },
    shutdown: (): void => {
      startGeneration += 1;
      stopRuntime();
      protocolUnsubscribe?.();
      protocolUnsubscribe = undefined;
      readyRequestUnsubscribe?.();
      readyRequestUnsubscribe = undefined;
    },
    start: async (ctx: ExtensionContext): Promise<void> => {
      const generation = ++startGeneration;
      stopRuntime();
      if (ctx.mode !== "tui") {
        return;
      }
      const loaded = await configStore.load();
      if (generation !== startGeneration) {
        return;
      }
      listenForProtocolMessages();
      const active: HostRuntime = {
        builtins: new Map(),
        collectorErrors: [],
        config: cloneFooterConfig(loaded.config),
        configLoaded: loaded,
        context: ctx,
        git: null,
        gitGeneration: 0,
        instanceId: randomUUID(),
        lifecycle: "starting",
        notifiedProtocolErrors: new Set(),
        protocolErrors: [],
        rich: new Map(),
        session: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          input: 0,
          output: 0,
        },
      };
      runtime = active;
      if (loaded.error !== undefined && loaded.error.length > 0) {
        ctx.ui.notify(`${loaded.error}; using Default in memory`, "warning");
      }
      if (sessionCanRender(active.config)) {
        try {
          active.session = collectSessionTotals(ctx);
        } catch (error) {
          addCollectorError(active, error);
        }
      }
      rebuildBuiltins(active);

      if (active.config.enabled) {
        installFooter(active);
      } else {
        active.lifecycle = "disabled";
      }
      emitReady(active);
      refreshGit(active);
      syncTimer(active);
    },
    turnEnd: (ctx: ExtensionContext): void => {
      const active = updateContext(ctx);
      if (active) {
        refreshSessionTotals(active);
        refreshGit(active);
      }
    },
  };
};
