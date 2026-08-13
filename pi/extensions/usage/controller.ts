import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { fetchClaudeUsage } from "./adapters/claude.js";
import { fetchCodexUsage } from "./adapters/codex.js";
import { fetchCopilotUsage } from "./adapters/copilot.js";
import { fetchKimiUsage } from "./adapters/kimi.js";
import { fetchMinimaxUsage } from "./adapters/minimax.js";
import { runCodexBarUsage } from "./adapters/opencode.js";
import type { AdapterDeps } from "./adapters/util.js";
import { fetchXaiUsage } from "./adapters/xai.js";
import { providerAuthClientFromContext } from "./auth.js";
import { UsageCache } from "./cache.js";
import {
  formatDetail,
  formatProviderError,
  formatRefreshFailed,
} from "./format.js";
import { defaultFetchJson } from "./http.js";
import { getActiveProvider, SUPPORTED_PROVIDERS } from "./providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
} from "./providers.js";
import {
  activeSnapshot,
  detailsSnapshot,
  fallbackText,
  STATUS_KEY,
} from "./widgets.js";
import type { HealthState, RichSnapshot } from "./widgets.js";

const FOOTER_READY_EVENT = "clanker-footer:ready";
const FOOTER_WIDGET_EVENT = "clanker-footer:widget";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const NO_AVAILABLE_PROVIDERS_MESSAGE =
  "usage: no supported providers are available (log in to a supported provider; opencode-go also requires CodexBar to be running)";

// Wrapped so tests can control time by spying on Date.now.
const now = (): number => Date.now();

type HttpUsageFetcher = (deps: AdapterDeps) => Promise<UsageFetchResult>;
type UsageFetcher = (ctx: ExtensionContext) => Promise<UsageFetchResult>;

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

export const createUsageController = (pi: ExtensionAPI) => {
  const cache = new UsageCache({ now });
  const fromHttpAdapter =
    (fetcher: HttpUsageFetcher): UsageFetcher =>
    (ctx) =>
      fetcher({
        authClient: providerAuthClientFromContext(ctx),
        fetchJson: defaultFetchJson,
        now,
      });
  const usageFetchers = {
    anthropic: fromHttpAdapter(fetchClaudeUsage),
    "github-copilot": fromHttpAdapter(fetchCopilotUsage),
    "kimi-coding": fromHttpAdapter(fetchKimiUsage),
    minimax: fromHttpAdapter((adapterDeps) =>
      fetchMinimaxUsage(adapterDeps, "minimax")
    ),
    "minimax-cn": fromHttpAdapter((adapterDeps) =>
      fetchMinimaxUsage(adapterDeps, "minimax-cn")
    ),
    "openai-codex": fromHttpAdapter(fetchCodexUsage),
    "opencode-go": () => runCodexBarUsage({ now }),
    xai: fromHttpAdapter(fetchXaiUsage),
  } satisfies Record<SupportedProvider, UsageFetcher>;

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

  const getOrFetch = (
    provider: SupportedProvider,
    ctx: ExtensionContext,
    force: boolean
  ): Promise<UsageFetchResult> =>
    cache.getOrFetch(provider, force, () => usageFetchers[provider](ctx));

  const refresh = (
    ctx: ExtensionContext,
    provider: SupportedProvider | undefined,
    force = false
  ): void => {
    generation += 1;
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
      const result = await getOrFetch(provider, ctx, force);
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

  listenForReady();

  return {
    dispose: (): void => {
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
    },
    runCommand: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const parsed = parseUsageArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "info");
        return;
      }
      refresh(ctx, getActiveProvider(ctx.model), parsed.refresh);
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
      }
      ctx.ui.notify(lines.join("\n\n"), "info");
    },
    start: (ctx: ExtensionContext): void => {
      if (ctx.mode !== "tui") {
        return;
      }
      listenForReady();
      refresh(ctx, getActiveProvider(ctx.model));
      stopTimer();
      refreshTimer = setInterval(() => {
        if (currentContext && activeProvider) {
          refresh(currentContext, activeProvider);
        }
      }, REFRESH_INTERVAL_MS);
    },
    trackModel: (
      ctx: ExtensionContext,
      model: { provider?: string } | undefined | null
    ): void => {
      if (ctx.mode === "tui") {
        refresh(ctx, getActiveProvider(model));
      }
    },
  };
};
