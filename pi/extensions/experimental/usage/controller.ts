import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { fetchClaudeUsage } from "./adapters/claude.js";
import { fetchCopilotUsage } from "./adapters/copilot.js";
import { fetchKimiUsage } from "./adapters/kimi.js";
import { fetchOpenCodeGoUsage } from "./adapters/opencode.js";
import { fetchOpenRouterUsage } from "./adapters/openrouter.js";
import { fetchRadiusUsage } from "./adapters/radius.js";
import type { AdapterDeps } from "./adapters/util.js";
import { fetchXaiUsage } from "./adapters/xai.js";
import { fetchZaiUsage } from "./adapters/zai.js";
import { contextAuth } from "./auth.js";
import type { GetAuth } from "./auth.js";
import { UsageCache } from "./cache.js";
import { formatDetail, formatProviderError, formatRefreshFailed } from "./format.js";
import { defaultFetchJson } from "./http.js";
import {
  isSupportedProvider,
  quotaUnavailableMessage,
  resolveQuotaProvider,
  SUPPORTED_PROVIDERS,
} from "./providers.js";
import type { SupportedProvider, UsageFetchResult } from "./providers.js";
import { usageFailure } from "./providers.js";
import { presentationProvider, STATUS_KEY, statusText } from "./status.js";
import type { UsagePresentation } from "./status.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;

const NO_AVAILABLE_PROVIDERS_MESSAGE =
  "usage: no supported providers are available (log in to a supported provider)";

export interface UsageControllerDependencies {
  fetchJson: typeof defaultFetchJson;
  now: () => number;
  getAuth: (ctx: ExtensionContext) => GetAuth;
  radiusBillingUrl?: (ctx: ExtensionContext) => string | undefined;
}

export const resolveRadiusBillingUrl = (
  baseUrls: readonly (string | undefined)[],
): string | undefined => {
  const candidates = baseUrls.filter((value): value is string => value !== undefined);

  if (candidates.length === 0) {
    return undefined;
  }

  const normalized = candidates.map((value) => {
    try {
      const url = new URL("/v1/billing", value);

      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  });

  if (normalized.some((value) => value === undefined)) {
    return undefined;
  }

  const distinct = new Set(normalized);

  return distinct.size === 1 ? distinct.values().next().value : undefined;
};

const radiusBillingUrlFromContext = (ctx: ExtensionContext): string | undefined => {
  const provider = ctx.modelRegistry.getProvider("radius");

  return provider === undefined
    ? undefined
    : resolveRadiusBillingUrl([
        provider.baseUrl,
        ...provider.getModels().map((model) => model.baseUrl),
      ]);
};

const defaultDependencies: UsageControllerDependencies = {
  fetchJson: defaultFetchJson,
  now: Date.now,
  getAuth: contextAuth,
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
  dependencies: UsageControllerDependencies = defaultDependencies,
) => {
  const { fetchJson, now, getAuth } = dependencies;
  const radiusBillingUrl = dependencies.radiusBillingUrl ?? radiusBillingUrlFromContext;
  const cache = new UsageCache({ now });

  const usageFetchers = {
    anthropic: fetchClaudeUsage,
    "github-copilot": fetchCopilotUsage,
    "kimi-coding": fetchKimiUsage,
    "opencode-go": fetchOpenCodeGoUsage,
    openrouter: fetchOpenRouterUsage,
    radius: async (deps: AdapterDeps, ctx: ExtensionContext) => {
      const billingUrl = radiusBillingUrl(ctx);

      return billingUrl === undefined
        ? usageFailure("could not determine Radius gateway", "unavailable")
        : await fetchRadiusUsage(deps, billingUrl);
    },
    xai: fetchXaiUsage,
    zai: fetchZaiUsage,
  } satisfies Record<
    SupportedProvider,
    (deps: AdapterDeps, ctx: ExtensionContext) => Promise<UsageFetchResult>
  >;

  let generation = 0;
  let disposed = false;
  let current: { context: ExtensionContext; presentation: UsagePresentation } | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const publish = (): void => {
    if (current?.context.mode === "tui") {
      current.context.ui.setStatus(
        STATUS_KEY,
        statusText(current.presentation, now(), current.context.ui.theme),
      );
    }
  };

  const clear = (ctx: ExtensionContext | undefined): void => {
    if (ctx?.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    current = undefined;
  };

  const getOrFetch = (
    provider: SupportedProvider,
    ctx: ExtensionContext,
    force: boolean,
  ): Promise<UsageFetchResult> =>
    cache.getOrFetch(provider, force, () =>
      usageFetchers[provider]({ getAuth: getAuth(ctx), fetchJson, now }, ctx),
    );

  const refresh = (ctx: ExtensionContext, provider: string | undefined, force = false): void => {
    generation += 1;

    // `/usage` explains a target without quota reporting; the status line stays empty.
    if (!isSupportedProvider(provider)) {
      clear(ctx);

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

      // Every target change and dispose starts a new generation.
      if (refreshGeneration !== generation) return;

      if (result.ok) {
        current = { context: ctx, presentation: { kind: "ready", snapshot: result.snapshot } };
      } else {
        const snapshot = cache.getLastSuccess(provider);
        current = {
          context: ctx,
          presentation: snapshot ? { kind: "stale", snapshot } : { kind: "error", provider },
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

  return {
    dispose: (): void => {
      disposed = true;
      generation += 1;
      stopTimer();
      clear(current?.context);
    },
    runCommand: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseUsageArgs(args);

      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "info");

        return;
      }

      const target = resolveQuotaProvider(ctx);
      refresh(ctx, target, parsed.refresh);

      const results = await Promise.all(
        SUPPORTED_PROVIDERS.map(async (provider) => ({
          provider,
          result: await getOrFetch(provider, ctx, parsed.refresh),
        })),
      );

      // Commands query accounts, not the selected model; only shutdown invalidates delivery.
      if (disposed) {
        return;
      }

      const available = results.filter(
        ({ result }) => result.ok || result.error.kind === "failure",
      );

      const targetResult = results.find(({ provider }) => provider === target)?.result;

      // The status line only says the target's usage is unavailable; name the reason here.
      const note = !isSupportedProvider(target)
        ? quotaUnavailableMessage(target)
        : targetResult?.ok === false && targetResult.error.kind === "unavailable"
          ? formatProviderError(target, targetResult.error.message)
          : undefined;

      if (available.length === 0) {
        ctx.ui.notify(note ?? NO_AVAILABLE_PROVIDERS_MESSAGE, "info");

        return;
      }

      const lines: string[] = note === undefined ? [] : [note];

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

      refresh(ctx, resolveQuotaProvider(ctx));
      stopTimer();
      refreshTimer = setInterval(() => {
        if (current) {
          refresh(current.context, presentationProvider(current.presentation));
        }
      }, REFRESH_INTERVAL_MS);
    },
    refresh: (ctx: ExtensionContext): void => {
      if (ctx.mode === "tui") refresh(ctx, resolveQuotaProvider(ctx));
    },
  };
};
