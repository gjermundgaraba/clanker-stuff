/* oxlint-disable eslint/no-nested-ternary -- snapshot content keeps its fallback states adjacent */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { fetchClaudeUsage } from "./adapters/claude.js";
import { fetchCodexUsage } from "./adapters/codex.js";
import { fetchCopilotUsage } from "./adapters/copilot.js";
import { fetchGeminiUsage } from "./adapters/gemini.js";
import { fetchKimiUsage } from "./adapters/kimi.js";
import { fetchMinimaxUsage } from "./adapters/minimax.js";
import type { CodexBarDiscover, CodexBarExec } from "./adapters/opencode.js";
import {
  defaultCodexBarExec,
  discoverCodexBarBinary,
  runCodexBarUsage,
} from "./adapters/opencode.js";
import type { AdapterDeps } from "./adapters/util.js";
import { fetchXaiUsage } from "./adapters/xai.js";
import type { ProviderAuthClient } from "./auth.js";
import { providerAuthClientFromContext } from "./auth.js";
import { UsageCache } from "./cache.js";
import {
  formatDetail,
  formatProviderError,
  formatRefreshFailed,
  formatResetDuration,
} from "./format.js";
import type { FetchJson } from "./http.js";
import { defaultFetchJson } from "./http.js";
import { getActiveProvider, providerDisplayName } from "./providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";
import { SUPPORTED_PROVIDERS } from "./types.js";

const FOOTER_READY_EVENT = "clanker-footer:ready";
const FOOTER_WIDGET_EVENT = "clanker-footer:widget";
const ACTIVE_WIDGET_ID = "clanker.usage.active";
const DETAILS_WIDGET_ID = "clanker.usage.details";
const STATUS_KEY = "usage";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const NO_AVAILABLE_PROVIDERS_MESSAGE =
  "usage: no supported providers are available (log in to a supported provider; opencode-go also requires CodexBar)";

type HealthState = "loading" | "ready" | "stale" | "error";
type Tone =
  | "text"
  | "dim"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error";

interface RichSnapshot {
  id: string;
  label: string;
  content: { text: string; tone?: Tone }[];
  consumesStatusKeys?: string[];
  defaults?: {
    enabled?: boolean;
  };
  health?: {
    state: HealthState;
    message?: string;
    updatedAt?: number;
  };
  icon?: {
    glyphs: {
      ascii: string;
      nerd: string;
      unicode: string;
    };
    tone?: Tone;
  };
  truncate?: "start" | "middle" | "end";
}

export interface UsageExtensionDeps {
  authClientFromContext?: (ctx: ExtensionContext) => ProviderAuthClient;
  discoverCodexBar?: CodexBarDiscover;
  execCodexBar?: CodexBarExec;
  fetchJson?: FetchJson;
  now?: () => number;
}

type HttpUsageFetcher = (deps: AdapterDeps) => Promise<UsageFetchResult>;
type UsageFetcher = (ctx: ExtensionContext) => Promise<UsageFetchResult>;

const richText = (value: string, maximum: number): string => {
  let result = "";
  let length = 0;
  for (const char of value) {
    if (length >= maximum) {
      break;
    }
    const code = char.codePointAt(0) ?? 0;
    result += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
    length += 1;
  }
  return result;
};

const usedPercent = (window: UsageWindow): number =>
  Math.min(100, Math.max(0, 100 - window.remainingPercent));

const toneFor = (percent: number): Tone => {
  if (percent >= 90) {
    return "error";
  }
  return percent >= 70 ? "warning" : "text";
};

const selectActiveWindow = (
  snapshot: UsageSnapshot
): UsageWindow | undefined => {
  let selected: UsageWindow | undefined;
  for (const window of snapshot.windows) {
    if (selected === undefined || usedPercent(window) > usedPercent(selected)) {
      selected = window;
    }
  }
  return selected;
};

const providerLabel = (snapshot: UsageSnapshot): string =>
  snapshot.planLabel !== undefined && snapshot.planLabel.length > 0
    ? richText(
        `${providerDisplayName(snapshot.provider)} (${snapshot.planLabel})`,
        160
      )
    : providerDisplayName(snapshot.provider);

const health = (
  state: HealthState,
  now: number,
  message?: string
): RichSnapshot["health"] => ({
  ...(message !== undefined && message.length > 0
    ? { message: richText(message, 512) }
    : {}),
  state,
  updatedAt: now,
});

const activeSnapshot = (
  snapshot: UsageSnapshot | undefined,
  state: HealthState,
  now: number,
  message?: string
): RichSnapshot => {
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  const percent = window ? usedPercent(window) : 0;
  const rounded = `${Math.round(percent)}%`;
  const reset =
    window?.resetsAt === undefined
      ? ""
      : ` · ${formatResetDuration(window.resetsAt, now)}`;
  const filled = Math.round((percent / 100) * 10);
  const full =
    snapshot && window
      ? [
          {
            text: `${providerLabel(snapshot)} ${richText(window.label, 80)} `,
            tone: "accent" as const,
          },
          { text: "━".repeat(filled), tone: toneFor(percent) },
          { text: "─".repeat(10 - filled), tone: "dim" as const },
          { text: ` ${rounded}${reset}`, tone: toneFor(percent) },
        ]
      : state === "loading"
        ? [{ text: "loading usage", tone: "dim" as const }]
        : [];
  return {
    consumesStatusKeys: [STATUS_KEY],
    content: full,
    defaults: { enabled: true },
    health: health(state, now, message),
    icon: {
      glyphs: { ascii: "usage", nerd: "󰓅", unicode: "◴" },
      tone: "dim",
    },
    id: ACTIVE_WIDGET_ID,
    label: "Active provider usage",
    truncate: "middle",
  };
};

const detailsSnapshot = (
  snapshot: UsageSnapshot | undefined,
  state: HealthState,
  now: number,
  message?: string
): RichSnapshot => {
  const active = snapshot ? selectActiveWindow(snapshot) : undefined;
  // ponytail: eight rich detail windows stay within protocol text bounds; /usage still shows all.
  const windows =
    snapshot?.windows.filter((window) => window !== active).slice(0, 8) ?? [];
  const full = windows.map((window, index) => ({
    text: `${index === 0 ? "" : " · "}${richText(window.label, 80)} ${Math.round(usedPercent(window))}%${
      window.resetsAt !== undefined && window.resetsAt.length > 0
        ? ` ${formatResetDuration(window.resetsAt, now)}`
        : ""
    }`,
    tone: toneFor(usedPercent(window)),
  }));
  return {
    consumesStatusKeys: [STATUS_KEY],
    content: full,
    defaults: { enabled: false },
    health: health(state, now, message),
    id: DETAILS_WIDGET_ID,
    label: "Provider usage details",
  };
};

const fallbackText = (
  snapshot: UsageSnapshot | undefined,
  state: HealthState
): string => {
  const window = snapshot ? selectActiveWindow(snapshot) : undefined;
  if (snapshot && window) {
    const marker = state === "stale" || state === "error" ? " !" : "";
    return richText(
      `usage ${providerDisplayName(snapshot.provider)} ${window.label} ${Math.round(usedPercent(window))}%${marker}`,
      240
    );
  }
  return state === "loading" ? "usage loading" : "usage unavailable";
};

const parseUsageArgs = (
  args: string
): { ok: true; refresh: boolean } | { ok: false; message: string } => {
  const command = args.trim();
  if (command === "") {
    return { ok: true, refresh: false };
  }
  return command === "refresh"
    ? { ok: true, refresh: true }
    : { message: "usage: expected /usage [refresh]", ok: false };
};

export const createUsageExtension = (deps: UsageExtensionDeps = {}) => {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const discoverCodexBar = deps.discoverCodexBar ?? discoverCodexBarBinary;
  const execCodexBar = deps.execCodexBar ?? defaultCodexBarExec;
  const now = deps.now ?? Date.now;
  const cache = new UsageCache({ now });
  const authClientFromContext =
    deps.authClientFromContext ?? providerAuthClientFromContext;
  const fromHttpAdapter =
    (fetcher: HttpUsageFetcher): UsageFetcher =>
    async (ctx) =>
      await fetcher({
        authClient: authClientFromContext(ctx),
        fetchJson,
        now,
      });
  const usageFetchers = {
    anthropic: fromHttpAdapter(fetchClaudeUsage),
    "github-copilot": fromHttpAdapter(fetchCopilotUsage),
    "google-gemini-cli": fromHttpAdapter(fetchGeminiUsage),
    "kimi-coding": fromHttpAdapter(fetchKimiUsage),
    minimax: fromHttpAdapter(
      async (adapterDeps) => await fetchMinimaxUsage(adapterDeps, "minimax")
    ),
    "minimax-cn": fromHttpAdapter(
      async (adapterDeps) => await fetchMinimaxUsage(adapterDeps, "minimax-cn")
    ),
    "openai-codex": fromHttpAdapter(fetchCodexUsage),
    "opencode-go": async () =>
      await runCodexBarUsage({
        discover: discoverCodexBar,
        exec: execCodexBar,
        now,
      }),
    xai: fromHttpAdapter(fetchXaiUsage),
  } satisfies Record<SupportedProvider, UsageFetcher>;

  return (pi: ExtensionAPI): void => {
    let generation = 0;
    let activeProvider: SupportedProvider | undefined;
    let currentContext: ExtensionContext | undefined;
    let currentHealth: HealthState = "loading";
    let currentMessage: string | undefined;
    let currentUsage: UsageSnapshot | undefined;
    let instanceId: string | undefined;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let readyUnsubscribe: (() => void) | undefined;
    const published = new Map<string, RichSnapshot>();

    const emit = (
      type: "upsert" | "remove",
      value: RichSnapshot | string
    ): void => {
      if (instanceId === undefined) {
        return;
      }
      pi.events.emit(
        FOOTER_WIDGET_EVENT,
        type === "upsert"
          ? {
              instanceId,
              protocol: 1,
              type,
              widget: value,
            }
          : { id: value, instanceId, protocol: 1, type }
      );
    };

    const publishSnapshot = (snapshot: RichSnapshot): void => {
      published.set(snapshot.id, snapshot);
      emit("upsert", snapshot);
    };

    const publish = (): void => {
      const ctx = currentContext;
      if (!ctx) {
        return;
      }
      publishSnapshot(
        activeSnapshot(currentUsage, currentHealth, now(), currentMessage)
      );
      publishSnapshot(
        detailsSnapshot(currentUsage, currentHealth, now(), currentMessage)
      );
      if (ctx.mode === "tui") {
        ctx.ui.setStatus(STATUS_KEY, fallbackText(currentUsage, currentHealth));
      }
    };

    const listenForReady = (): void => {
      readyUnsubscribe ??= pi.events.on(FOOTER_READY_EVENT, (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("protocol" in value) ||
          value.protocol !== 1 ||
          !("type" in value) ||
          value.type !== "ready" ||
          !("instanceId" in value) ||
          typeof value.instanceId !== "string"
        ) {
          return;
        }
        const { instanceId: readyInstanceId } = value;
        if (instanceId === readyInstanceId) {
          return;
        }
        instanceId = readyInstanceId;
        for (const snapshot of published.values()) {
          emit("upsert", snapshot);
        }
      });
    };

    const getOrFetch = async (
      provider: SupportedProvider,
      ctx: ExtensionContext,
      force: boolean
    ): Promise<UsageFetchResult> =>
      await cache.getOrFetch(
        provider,
        force,
        async () => await usageFetchers[provider](ctx)
      );

    const refresh = (
      ctx: ExtensionContext,
      provider: SupportedProvider | undefined
    ): void => {
      currentContext = ctx;
      activeProvider = provider;
      currentMessage = undefined;
      if (!provider) {
        currentUsage = undefined;
        currentHealth = "error";
        publish();
        return;
      }

      const last = cache.getLastSuccess(provider);
      currentUsage = last;
      currentHealth = last ? "ready" : "loading";
      publish();
      const refreshGeneration = generation;
      void (async () => {
        const result = await getOrFetch(provider, ctx, false);
        if (refreshGeneration !== generation || activeProvider !== provider) {
          return;
        }
        if (result.ok) {
          currentUsage = result.snapshot;
          currentHealth = "ready";
          currentMessage = undefined;
        } else {
          currentUsage = cache.getLastSuccess(provider);
          currentHealth = currentUsage ? "stale" : "error";
          currentMessage = result.error.message;
        }
        publish();
      })();
    };

    const stopTimer = (): void => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    };

    const runUsageCommand = async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const parsed = parseUsageArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "info");
        return;
      }
      currentContext = ctx;
      const active = getActiveProvider(ctx.model);
      const results = await Promise.all(
        SUPPORTED_PROVIDERS.map(async (provider) => ({
          provider,
          result: await getOrFetch(provider, ctx, parsed.refresh),
        }))
      );
      const available = results.filter(
        ({ result }) => result.ok || result.error.kind === "failure"
      );
      if (available.length === 0) {
        ctx.ui.notify(NO_AVAILABLE_PROVIDERS_MESSAGE, "info");
        return;
      }

      const lines: string[] = [];
      for (const { provider, result } of available) {
        const snapshot = result.ok
          ? result.snapshot
          : cache.getLastSuccess(provider);
        if (snapshot) {
          const [header = "", ...details] = formatDetail(snapshot, now()).split(
            "\n"
          );
          lines.push([ctx.ui.theme.bold(header), ...details].join("\n"));
        }
        if (!result.ok) {
          lines.push(
            snapshot
              ? formatRefreshFailed(
                  provider,
                  result.error.message,
                  snapshot.fetchedAt,
                  now()
                )
              : formatProviderError(provider, result.error.message)
          );
        }
        if (provider === active) {
          currentUsage = snapshot;
          if (result.ok) {
            currentHealth = "ready";
          } else {
            currentHealth = snapshot ? "stale" : "error";
          }
          currentMessage = result.ok ? undefined : result.error.message;
        }
      }
      publish();
      ctx.ui.notify(lines.join("\n\n"), "info");
    };

    listenForReady();
    pi.registerCommand("usage", {
      description: "Show subscription usage for supported providers",
      handler: runUsageCommand,
    });

    pi.on("session_start", (_event, ctx) => {
      listenForReady();
      generation += 1;
      currentContext = ctx;
      refresh(ctx, getActiveProvider(ctx.model));
      stopTimer();
      refreshTimer = setInterval(() => {
        if (currentContext && activeProvider) {
          refresh(currentContext, activeProvider);
        }
      }, REFRESH_INTERVAL_MS);
    });
    pi.on("model_select", (event, ctx) => {
      refresh(ctx, getActiveProvider(event.model));
    });
    pi.on("agent_settled", (_event, ctx) => {
      refresh(ctx, getActiveProvider(ctx.model));
    });
    pi.on("session_shutdown", () => {
      generation += 1;
      stopTimer();
      for (const id of published.keys()) {
        emit("remove", id);
      }
      if (currentContext?.mode === "tui") {
        currentContext.ui.setStatus(STATUS_KEY, undefined);
      }
      published.clear();
      readyUnsubscribe?.();
      readyUnsubscribe = undefined;
      instanceId = undefined;
      activeProvider = undefined;
      currentContext = undefined;
      currentHealth = "loading";
      currentMessage = undefined;
      currentUsage = undefined;
    });
  };
};

export default createUsageExtension();
