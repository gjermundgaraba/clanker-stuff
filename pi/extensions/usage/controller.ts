import {
  FOOTER_PROTOCOL_VERSION,
  FOOTER_READY_EVENT,
  FOOTER_READY_REQUEST_EVENT,
  FOOTER_WIDGET_EVENT,
  isFooterReadyMessage,
} from "@clanker-stuff/footer-protocol";
import type { FooterWidgetSnapshot } from "@clanker-stuff/footer-protocol";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AdapterDeps } from "./adapters/util.js";
import { providerAuthClientFromContext } from "./auth.js";
import type { ProviderAuthClient } from "./auth.js";
import { UsageCache } from "./cache.js";
import { formatDetail, formatProviderError, formatRefreshFailed } from "./format.js";
import { defaultFetchJson } from "./http.js";
import { getActiveProvider, SUPPORTED_PROVIDERS } from "./providers.js";
import type { SupportedProvider, UsageFetchResult } from "./providers.js";
import {
  activeSnapshot,
  detailsSnapshot,
  fallbackText,
  presentationProvider,
  STATUS_KEY,
} from "./widgets.js";
import type { UsagePresentation } from "./widgets.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const NO_AVAILABLE_PROVIDERS_MESSAGE =
  "usage: no supported providers are available (log in to a supported provider; opencode-go also requires CodexBar to be running)";

type UsageFetcher = (ctx: ExtensionContext) => Promise<UsageFetchResult>;
type HttpUsageFetcher = (deps: AdapterDeps) => Promise<UsageFetchResult>;

export interface UsageControllerDependencies {
  fetchJson: typeof defaultFetchJson;
  now: () => number;
  providerAuthClient: (ctx: ExtensionContext) => ProviderAuthClient;
}

const defaultDependencies: UsageControllerDependencies = {
  fetchJson: defaultFetchJson,
  now: Date.now,
  providerAuthClient: providerAuthClientFromContext,
};

const parseUsageArgs = (
  args: string,
): { ok: true; refresh: boolean } | { ok: false; message: string } => {
  const command = args.trim();
  if (command === "") {
    return { ok: true, refresh: false };
  }
  return command === "refresh"
    ? { ok: true, refresh: true }
    : { message: "usage: expected /usage [refresh]", ok: false };
};

export const createUsageController = (
  pi: ExtensionAPI,
  dependencies: UsageControllerDependencies = defaultDependencies,
) => {
  const { fetchJson, now, providerAuthClient } = dependencies;
  let cache = new UsageCache({ now });
  const fromHttpAdapter =
    (fetcher: HttpUsageFetcher): UsageFetcher =>
    (ctx) =>
      fetcher({
        authClient: providerAuthClient(ctx),
        fetchJson,
        now,
      });
  const usageFetchers = {
    anthropic: fromHttpAdapter(async (deps) => {
      const { fetchClaudeUsage } = await import("./adapters/claude.js");
      return await fetchClaudeUsage(deps);
    }),
    "github-copilot": fromHttpAdapter(async (deps) => {
      const { fetchCopilotUsage } = await import("./adapters/copilot.js");
      return await fetchCopilotUsage(deps);
    }),
    "kimi-coding": fromHttpAdapter(async (deps) => {
      const { fetchKimiUsage } = await import("./adapters/kimi.js");
      return await fetchKimiUsage(deps);
    }),
    minimax: fromHttpAdapter(async (deps) => {
      const { fetchMinimaxUsage } = await import("./adapters/minimax.js");
      return await fetchMinimaxUsage(deps, "minimax");
    }),
    "minimax-cn": fromHttpAdapter(async (deps) => {
      const { fetchMinimaxUsage } = await import("./adapters/minimax.js");
      return await fetchMinimaxUsage(deps, "minimax-cn");
    }),
    "openai-codex": fromHttpAdapter(async (deps) => {
      const { fetchCodexUsage } = await import("./adapters/codex.js");
      return await fetchCodexUsage(deps);
    }),
    "opencode-go": async () => {
      const { runCodexBarUsage } = await import("./adapters/opencode.js");
      return await runCodexBarUsage({ now });
    },
    xai: fromHttpAdapter(async (deps) => {
      const { fetchXaiUsage } = await import("./adapters/xai.js");
      return await fetchXaiUsage(deps);
    }),
    zai: fromHttpAdapter(async (deps) => {
      const { fetchZaiUsage } = await import("./adapters/zai.js");
      return await fetchZaiUsage(deps);
    }),
  } satisfies Record<SupportedProvider, UsageFetcher>;

  let generation = 0;
  let current: { context: ExtensionContext; presentation: UsagePresentation } | undefined;
  const getCurrent = () => current;
  let instanceId: string | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let readyUnsubscribe: (() => void) | undefined;
  const published = new Map<string, FooterWidgetSnapshot>();

  const emit = (type: "upsert" | "remove", value: FooterWidgetSnapshot | string): void => {
    if (instanceId === undefined) {
      return;
    }
    pi.events.emit(
      FOOTER_WIDGET_EVENT,
      type === "upsert"
        ? {
            instanceId,
            protocol: FOOTER_PROTOCOL_VERSION,
            type,
            widget: value,
          }
        : { id: value, instanceId, protocol: FOOTER_PROTOCOL_VERSION, type },
    );
  };

  const publishSnapshot = (snapshot: FooterWidgetSnapshot): void => {
    published.set(snapshot.id, snapshot);
    emit("upsert", snapshot);
  };

  const publish = (): void => {
    if (!current) {
      return;
    }
    publishSnapshot(activeSnapshot(current.presentation, now()));
    publishSnapshot(detailsSnapshot(current.presentation, now()));
    if (current.context.mode === "tui") {
      current.context.ui.setStatus(STATUS_KEY, fallbackText(current.presentation));
    }
  };

  const listenForReady = (): void => {
    if (readyUnsubscribe !== undefined) {
      return;
    }
    readyUnsubscribe = pi.events.on(FOOTER_READY_EVENT, (value) => {
      if (!isFooterReadyMessage(value)) {
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
    pi.events.emit(FOOTER_READY_REQUEST_EVENT, {
      protocol: FOOTER_PROTOCOL_VERSION,
      type: "ready-request",
    });
  };

  const getOrFetch = (
    provider: SupportedProvider,
    ctx: ExtensionContext,
    force: boolean,
  ): Promise<UsageFetchResult> =>
    cache.getOrFetch(provider, force, () => usageFetchers[provider](ctx));

  const refresh = (
    ctx: ExtensionContext,
    provider: SupportedProvider | undefined,
    force = false,
  ): void => {
    generation += 1;
    if (!provider) {
      current = { context: ctx, presentation: { kind: "unsupported" } };
      publish();
      return;
    }

    const last = cache.getLastSuccess(provider);
    current = {
      context: ctx,
      presentation: last ? { kind: "ready", snapshot: last } : { kind: "loading", provider },
    };
    publish();
    const refreshGeneration = generation;
    void (async () => {
      const result = await getOrFetch(provider, ctx, force);
      const active = getCurrent();
      if (
        refreshGeneration !== generation ||
        active === undefined ||
        presentationProvider(active.presentation) !== provider
      ) {
        return;
      }
      if (result.ok) {
        current = {
          context: ctx,
          presentation: { kind: "ready", snapshot: result.snapshot },
        };
      } else {
        const snapshot = cache.getLastSuccess(provider);
        current = {
          context: ctx,
          presentation: snapshot
            ? { kind: "stale", message: result.error.message, snapshot }
            : { kind: "error", message: result.error.message, provider },
        };
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

  const accountUnsubscribe = pi.events.on("clanker-codex:account-changed", () => {
    cache = new UsageCache({ now });
    if (current && presentationProvider(current.presentation) === "openai-codex") {
      refresh(current.context, "openai-codex");
    }
  });

  listenForReady();

  return {
    dispose: (): void => {
      generation += 1;
      stopTimer();
      for (const id of published.keys()) {
        emit("remove", id);
      }
      if (current?.context.mode === "tui") {
        current.context.ui.setStatus(STATUS_KEY, undefined);
      }
      published.clear();
      accountUnsubscribe();
      readyUnsubscribe?.();
      readyUnsubscribe = undefined;
      instanceId = undefined;
      current = undefined;
    },
    runCommand: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
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
        })),
      );
      const available = results.filter(
        ({ result }) => result.ok || result.error.kind === "failure",
      );
      if (available.length === 0) {
        ctx.ui.notify(NO_AVAILABLE_PROVIDERS_MESSAGE, "info");
        return;
      }

      const lines: string[] = [];
      for (const { provider, result } of available) {
        const snapshot = result.ok ? result.snapshot : cache.getLastSuccess(provider);
        if (snapshot) {
          const [header = "", ...details] = formatDetail(snapshot, now()).split("\n");
          lines.push([ctx.ui.theme.bold(header), ...details].join("\n"));
        }
        if (!result.ok) {
          lines.push(
            snapshot
              ? formatRefreshFailed(provider, result.error.message, snapshot.fetchedAt, now())
              : formatProviderError(provider, result.error.message),
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
        if (current) {
          const provider = presentationProvider(current.presentation);
          if (provider) {
            refresh(current.context, provider);
          }
        }
      }, REFRESH_INTERVAL_MS);
    },
    trackModel: (ctx: ExtensionContext, model: { provider?: string } | undefined | null): void => {
      if (ctx.mode === "tui") {
        refresh(ctx, getActiveProvider(model));
      }
    },
  };
};
