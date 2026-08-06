/* oxlint-disable eslint/no-use-before-define, eslint/no-plusplus, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, typescript/no-misused-spread, unicorn/consistent-function-scoping, unicorn/no-useless-collection-argument -- lifecycle helpers stay adjacent to their state; summaries use protocol-defined code points */

import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  cloneFooterConfig,
  createFooterConfigStore,
  hasTerminalControl,
} from "./config.js";
import type { FooterConfigStore, LoadedFooterConfig } from "./config.js";
import type { GitStatus } from "./git.js";
import { readGitStatus, sameGitStatus } from "./git.js";
import { renderFooterState, sanitizeNativeStatus } from "./layout.js";
import { validateFooterWidgetMessage } from "./protocol.js";
import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_WIDGET_EVENT,
  MAX_PROTOCOL_ERRORS,
  MAX_RICH_WIDGETS,
} from "./types.js";
import type {
  FooterConfig,
  FooterContent,
  FooterLayoutResult,
  FooterLifecycleState,
  FooterRenderState,
  LiveWidget,
  ProtocolErrorRecord,
} from "./types.js";
import { showFooterEditor, showFooterTextView } from "./ui.js";
import type { FooterEditorWidget } from "./ui.js";
import { buildBuiltinWidgets, collectSessionTotals } from "./widgets.js";
import type { SessionTotals } from "./widgets.js";

const SESSION_TICK_MS = 60_000;
const RETAINED_COLLECTOR_ERRORS = 50;

export interface FooterExtensionDeps {
  configStore?: FooterConfigStore;
  now?: () => number;
  readGit?: (
    runtime: Pick<ExtensionAPI, "exec">,
    cwd: string
  ) => Promise<GitStatus | null>;
}

interface HostRuntime {
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

const summary = (value: string): string =>
  [...value]
    .slice(0, 512)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    })
    .join("");

const duplicatePlacements = (config: FooterConfig): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of config.rows) {
    for (const group of ["left", "center", "right"] as const) {
      for (const id of row[group]) {
        if (seen.has(id)) {
          duplicates.add(id);
        }
        seen.add(id);
      }
    }
  }
  return [...duplicates];
};

const sessionCanRender = (config: FooterConfig): boolean =>
  config.enabled &&
  config.widgets["footer.session"]?.enabled !== false &&
  config.rows.some((row) =>
    [row.left, row.center, row.right].some((group) =>
      group.includes("footer.session")
    )
  );

export const createFooterExtension = (deps: FooterExtensionDeps = {}) => {
  const now = deps.now ?? Date.now;
  const configStore = deps.configStore ?? createFooterConfigStore();
  const readGit = deps.readGit ?? readGitStatus;

  return (pi: ExtensionAPI): void => {
    let runtime: HostRuntime | undefined;
    let branchUnsubscribe: (() => void) | undefined;
    let protocolUnsubscribe: (() => void) | undefined;
    let sessionTimer: ReturnType<typeof setInterval> | undefined;
    let intentionalFooterDisposal = false;

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
        timestamp: now(),
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
          now: now(),
          session: active.session,
          thinkingLevel: active.context.thinkingLevel ?? pi.getThinkingLevel(),
        });
      } catch (error) {
        addCollectorError(active, error);
      }
      active.requestRender?.();
    };

    const refreshSessionTotals = (active: HostRuntime): void => {
      try {
        active.session = collectSessionTotals(active.context);
      } catch (error) {
        addCollectorError(active, error);
      }
      rebuildBuiltins(active);
    };

    const refreshGit = (active: HostRuntime): void => {
      const generation = ++active.gitGeneration;
      const { cwd } = active.context;
      void readGit(pi, cwd)
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
      intentionalFooterDisposal = true;
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
        intentionalFooterDisposal = false;

        return {
          dispose() {
            disposeBranchSubscription();
            active.requestRender = undefined;
            if (
              runtime === active &&
              active.lifecycle === "active" &&
              !intentionalFooterDisposal
            ) {
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
      intentionalFooterDisposal = false;
      syncTimer(active);
    };

    const disableFooter = (active: HostRuntime): void => {
      if (active.lifecycle !== "active") {
        return;
      }
      intentionalFooterDisposal = true;
      active.lifecycle = "disabled";
      disposeBranchSubscription();
      active.context.ui.setFooter(undefined);
      active.requestRender = undefined;
      intentionalFooterDisposal = false;
      syncTimer(active);
    };

    const applyConfig = (active: HostRuntime, config: FooterConfig): void => {
      active.config = cloneFooterConfig(config);
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
        intentionalFooterDisposal = true;
        active.context.ui.setFooter(undefined);
        intentionalFooterDisposal = false;
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

    const listenForProtocolMessages = (): void => {
      protocolUnsubscribe ??= pi.events.on(
        FOOTER_WIDGET_EVENT,
        handleWidgetMessage
      );
    };

    listenForProtocolMessages();

    const updateContext = (ctx: ExtensionContext): HostRuntime | undefined => {
      if (runtime) {
        runtime.context = ctx;
      }
      return runtime;
    };

    pi.registerCommand("footer", {
      description: "Configure or inspect the cooperative footer",
      handler: async (args, ctx) => {
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
        if (command === "inspect") {
          await showFooterTextView(ctx, "Footer inspect", () =>
            inspectLines(active, now())
          );
          return;
        }
        if (command === "doctor") {
          await showFooterTextView(ctx, "Footer doctor", () =>
            doctorLines(active, configStore.path)
          );
          return;
        }
        if (command !== "") {
          ctx.ui.notify("usage: /footer [inspect|doctor]", "info");
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
    });

    pi.on("session_start", async (_event, ctx) => {
      listenForProtocolMessages();
      stopRuntime();
      const loaded = await configStore.load();
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
      try {
        active.session = collectSessionTotals(ctx);
      } catch (error) {
        addCollectorError(active, error);
      }
      rebuildBuiltins(active);

      if (ctx.mode === "tui" && active.config.enabled) {
        installFooter(active);
      } else {
        active.lifecycle = "disabled";
      }
      pi.events.emit(FOOTER_READY_EVENT, {
        instanceId: active.instanceId,
        protocol: FOOTER_PROTOCOL_VERSION,
        type: "ready",
      });
      if (ctx.mode === "tui") {
        refreshGit(active);
        syncTimer(active);
      }
    });

    pi.on("model_select", (_event, ctx) => {
      const active = updateContext(ctx);
      if (active) {
        rebuildBuiltins(active);
      }
    });
    pi.on("thinking_level_select", (_event, ctx) => {
      const active = updateContext(ctx);
      if (active) {
        rebuildBuiltins(active);
      }
    });
    pi.on("message_end", (_event, ctx) => {
      const active = updateContext(ctx);
      if (active) {
        rebuildBuiltins(active);
      }
    });
    const postPersistenceRefresh = (
      _event: unknown,
      ctx: ExtensionContext
    ): void => {
      const active = updateContext(ctx);
      if (active) {
        refreshSessionTotals(active);
      }
    };
    pi.on("turn_end", (_event, ctx) => {
      postPersistenceRefresh(_event, ctx);
      const active = runtime;
      if (active) {
        refreshGit(active);
      }
    });
    pi.on("agent_settled", postPersistenceRefresh);
    pi.on("session_tree", postPersistenceRefresh);
    pi.on("session_compact", postPersistenceRefresh);
    pi.on("session_info_changed", postPersistenceRefresh);

    pi.on("session_shutdown", () => {
      stopRuntime();
      protocolUnsubscribe?.();
      protocolUnsubscribe = undefined;
    });
  };
};

const editorWidgets = (runtime: HostRuntime): FooterEditorWidget[] => {
  const widgets: FooterEditorWidget[] = [
    ...runtime.builtins.values(),
    ...runtime.rich.values(),
  ].map((widget) => ({
    defaultEnabled: widget.snapshot.defaults?.enabled,
    id: widget.snapshot.id,
    label: widget.snapshot.label,
    source: widget.source,
  }));
  for (const [key, value] of runtime.footerData?.getExtensionStatuses() ?? []) {
    if (
      !hasTerminalControl(key) &&
      visibleWidth(sanitizeNativeStatus(value)) > 0
    ) {
      widgets.push({
        id: `status:${key}`,
        label: key,
        source: "native",
      });
    }
  }
  widgets.push(
    {
      id: "footer.widgets",
      label: "Rich widgets",
      source: "builtin",
    },
    {
      id: "footer.statuses",
      label: "Native statuses",
      source: "builtin",
    }
  );
  return widgets.toSorted((left, right) => left.id.localeCompare(right.id));
};

const placementFor = (runtime: HostRuntime, id: string): string => {
  for (const [rowIndex, row] of runtime.config.rows.entries()) {
    for (const group of ["left", "center", "right"] as const) {
      const index = row[group].indexOf(id);
      if (index !== -1) {
        return `row ${rowIndex + 1} ${group} #${index + 1}`;
      }
    }
  }
  return "aggregate or unavailable";
};

const plainContent = (content: FooterContent): string =>
  content.map((span) => span.text).join("");

const healthAge = (updatedAt: number | undefined, timestamp: number): string =>
  updatedAt === undefined
    ? "unknown"
    : `${Math.max(0, Math.round((timestamp - updatedAt) / 1000))}s`;

const healthLines = (widget: LiveWidget, timestamp: number): string[] => [
  `  health: ${widget.snapshot.health?.state ?? "none"} · age ${healthAge(widget.snapshot.health?.updatedAt, timestamp)}`,
  ...(widget.snapshot.health?.message === undefined
    ? []
    : [`  health detail: ${summary(widget.snapshot.health.message)}`]),
];

const inspectLines = (runtime: HostRuntime, timestamp: number): string[] => {
  const byDecision = new Map(
    runtime.lastLayout?.decisions.map((decision) => [
      decision.id,
      `${decision.outcome}: ${decision.reason}`,
    ]) ?? []
  );
  const lines =
    runtime.lastLayout?.duplicates.map(
      (id) => `duplicate placement: ${summary(id)}`
    ) ?? [];
  for (const widget of [
    ...runtime.builtins.values(),
    ...runtime.rich.values(),
  ].toSorted((left, right) =>
    left.snapshot.id.localeCompare(right.snapshot.id)
  )) {
    const { content } = widget.snapshot;
    lines.push(
      `${summary(widget.snapshot.id)} [${widget.source}]`,
      `  content: ${plainContent(content)}`,
      ...healthLines(widget, timestamp),
      `  producer defaults: ${JSON.stringify(widget.snapshot.defaults ?? {})}`,
      `  user override: ${JSON.stringify(runtime.config.widgets[widget.snapshot.id] ?? {})}`,
      `  placement: ${placementFor(runtime, widget.snapshot.id)}`,
      `  layout: ${byDecision.get(widget.snapshot.id) ?? "not rendered"}`
    );
  }
  for (const [key, value] of runtime.footerData?.getExtensionStatuses() ?? []) {
    const id = `status:${key}`;
    const consumers = [...runtime.rich.values()]
      .filter(
        (widget) => widget.snapshot.consumesStatusKeys?.includes(key) === true
      )
      .map((widget) => widget.snapshot.id)
      .toSorted();
    const layout =
      byDecision.get(id) ??
      (runtime.lastLayout?.consumedStatusIds.includes(id) === true
        ? `consumed by ${consumers.join(", ") || "rich widget"}`
        : "not rendered");
    lines.push(
      `${summary(id)} [native]`,
      `  content: ${sanitizeNativeStatus(value)}`,
      `  user override: ${JSON.stringify(runtime.config.widgets[id] ?? {})}`,
      `  placement: ${placementFor(runtime, id)}`,
      `  layout: ${summary(layout)}`
    );
  }
  return lines.length === 0 ? ["No live widgets."] : lines;
};

const doctorLines = (runtime: HostRuntime, configPath: string): string[] => {
  const duplicates = duplicatePlacements(runtime.config);
  const lines = [
    `ownership: ${runtime.lifecycle}`,
    `protocol: v${FOOTER_PROTOCOL_VERSION}`,
    `instance: ${summary(runtime.instanceId)}`,
    `config: ${summary(configPath)}`,
    `rich widgets: ${[...runtime.rich.keys()].toSorted().map(summary).join(", ") || "none"}`,
    `duplicate placements: ${duplicates.map(summary).join(", ") || "none"}`,
  ];
  if (
    runtime.configLoaded.error !== undefined &&
    runtime.configLoaded.error.length > 0
  ) {
    lines.push(`config error: ${summary(runtime.configLoaded.error)}`);
  }
  lines.push(
    ...(runtime.collectorErrors.length === 0
      ? ["collector errors: none"]
      : runtime.collectorErrors.map((error) => `collector error: ${error}`)),
    ...(runtime.protocolErrors.length === 0
      ? ["protocol errors: none"]
      : runtime.protocolErrors.map(
          (error) =>
            `${new Date(error.timestamp).toISOString()} ${error.class}: ${error.message}`
        ))
  );
  return lines;
};

export {
  validateFooterWidgetMessage,
  validateFooterWidgetSnapshot,
  validateRichWidgetId,
} from "./protocol.js";
export {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_WIDGET_EVENT,
} from "./types.js";
export type { ValidationResult } from "./protocol.js";
export type {
  FooterContent,
  FooterReadyMessage,
  FooterSpan,
  FooterTruncation,
  FooterWidgetMessage,
  FooterWidgetSnapshot,
} from "./types.js";

export default createFooterExtension();
