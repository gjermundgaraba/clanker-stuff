import { createHmac, randomBytes } from "node:crypto";

import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { fetchClaudeUsage } from "./adapters/claude.js";
import { fetchCodexUsage } from "./adapters/codex.js";
import { fetchCopilotUsage } from "./adapters/copilot.js";
import { fetchKimiUsage } from "./adapters/kimi.js";
import { fetchOpenCodeGoUsage } from "./adapters/opencode.js";
import { fetchOpenRouterUsage } from "./adapters/openrouter.js";
import { fetchRadiusUsage } from "./adapters/radius.js";
import type { AdapterDeps } from "./adapters/util.js";
import { fetchXaiUsage } from "./adapters/xai.js";
import { fetchZaiUsage } from "./adapters/zai.js";
import { contextAuth, resolveUsageCredential } from "./auth.js";
import type { GetAuth } from "./auth.js";
import { UsageCache } from "./cache.js";
import { parseUsageArgs } from "./command.js";
import {
  formatDetail,
  formatProviderError,
  formatRefreshFailed,
} from "./format.js";
import { defaultFetchJson } from "./http.js";
import {
  isSupportedProvider,
  quotaUnavailableMessage,
  resolveQuotaProvider,
  SUPPORTED_PROVIDERS,
  usageFailure,
} from "./providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
} from "./providers.js";
import { STATUS_KEY, statusText } from "./status.js";
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
  baseUrls: ReadonlyArray<string | undefined>
): string | undefined => {
  const distinct = new Set<string>();

  for (const baseUrl of baseUrls) {
    if (baseUrl === undefined) {
      continue;
    }

    try {
      const url = new URL("/v1/billing", baseUrl);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return undefined;
      }

      distinct.add(url.toString());
    } catch {
      return undefined;
    }
  }

  return distinct.size === 1 ? distinct.values().next().value : undefined;
};

const radiusBillingUrlFromContext = (
  ctx: ExtensionContext
): string | undefined => {
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

const fixedEndpointFetchers = {
  anthropic: fetchClaudeUsage,
  "openai-codex": fetchCodexUsage,
  "github-copilot": fetchCopilotUsage,
  "kimi-coding": fetchKimiUsage,
  "opencode-go": fetchOpenCodeGoUsage,
  openrouter: fetchOpenRouterUsage,
  xai: fetchXaiUsage,
  zai: fetchZaiUsage,
} satisfies Record<
  Exclude<SupportedProvider, "radius">,
  (deps: AdapterDeps) => Promise<UsageFetchResult>
>;

interface UsageReading {
  result: UsageFetchResult;
  snapshot?: UsageSnapshot;
}

export const createUsageController = (
  dependencies: UsageControllerDependencies = defaultDependencies
) => {
  const { fetchJson, now, getAuth } = dependencies;

  const radiusBillingUrl =
    dependencies.radiusBillingUrl ?? radiusBillingUrlFromContext;

  const cache = new UsageCache(now);
  const scopeSecret = randomBytes(32);

  const resolveEndpoint = (
    provider: SupportedProvider,
    ctx: ExtensionContext
  ) => {
    if (provider !== "radius") {
      return {
        billingUrl: undefined,
        fetchUsage: fixedEndpointFetchers[provider],
      };
    }

    const billingUrl = radiusBillingUrl(ctx);

    return billingUrl === undefined
      ? undefined
      : {
          billingUrl,
          fetchUsage: async (deps: AdapterDeps) =>
            await fetchRadiusUsage(deps, billingUrl),
        };
  };

  let generation = 0;
  let disposed = false;

  let current:
    | { context: ExtensionContext; provider: SupportedProvider }
    | undefined;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const clear = (ctx: ExtensionContext | undefined): void => {
    if (ctx?.mode === "tui") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    current = undefined;
  };

  const readUsage = async (
    provider: SupportedProvider,
    ctx: ExtensionContext,
    force: boolean,
    onScopeResolved?: (last: UsageSnapshot | undefined) => void
  ): Promise<UsageReading> => {
    const endpoint = resolveEndpoint(provider, ctx);

    if (endpoint === undefined) {
      return {
        result: usageFailure(
          "could not determine Radius gateway",
          "unavailable"
        ),
      };
    }

    const auth = await resolveUsageCredential(getAuth(ctx), provider);

    if (!auth.ok) {
      return { result: auth };
    }

    const { credential } = auth;

    const scopeFingerprint = createHmac("sha256", scopeSecret)
      .update(
        JSON.stringify([
          provider,
          endpoint.billingUrl,
          credential.oauth,
          credential.token,
        ])
      )
      .digest("hex");

    onScopeResolved?.(cache.getLastSuccess(scopeFingerprint));

    const result = await cache.getOrFetch(
      scopeFingerprint,
      force,
      async () => await endpoint.fetchUsage({ credential, fetchJson, now })
    );

    const snapshot = result.ok
      ? result.snapshot
      : cache.getLastSuccess(scopeFingerprint);

    return { result, ...(snapshot === undefined ? {} : { snapshot }) };
  };

  const refresh = (
    ctx: ExtensionContext,
    provider: string | undefined,
    force = false
  ): Promise<UsageReading> | undefined => {
    generation += 1;
    const refreshGeneration = generation;

    if (!isSupportedProvider(provider)) {
      clear(ctx);

      return undefined;
    }

    const show = (presentation: UsagePresentation): void => {
      if (refreshGeneration === generation && ctx.mode === "tui") {
        ctx.ui.setStatus(
          STATUS_KEY,
          statusText(presentation, now(), ctx.ui.theme)
        );
      }
    };

    if (current?.provider !== provider) {
      show({ kind: "loading", provider });
    }

    current = { context: ctx, provider };

    return readUsage(provider, ctx, force, (snapshot) => {
      show(
        snapshot ? { kind: "ready", snapshot } : { kind: "loading", provider }
      );
    }).then((reading) => {
      const { result, snapshot } = reading;

      if (snapshot === undefined) {
        show({ kind: "error", provider });
      } else {
        show({ kind: result.ok ? "ready" : "stale", snapshot });
      }

      return reading;
    });
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
    runCommand: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const parsed = parseUsageArgs(args);

      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "info");

        return;
      }

      const target = resolveQuotaProvider(ctx);
      const active = refresh(ctx, target, parsed.refresh);

      const results = await Promise.all(
        SUPPORTED_PROVIDERS.map(async (provider) => {
          const reading =
            provider === target && active !== undefined
              ? await active
              : await readUsage(provider, ctx, parsed.refresh);

          return { provider, ...reading };
        })
      );

      if (disposed) {
        return;
      }

      const available = results.filter(
        ({ result }) => result.ok || result.error.kind === "failure"
      );

      const targetResult = results.find(
        ({ provider }) => provider === target
      )?.result;

      let note: string | undefined;

      if (!isSupportedProvider(target)) {
        note = quotaUnavailableMessage(target);
      } else if (
        targetResult?.ok === false &&
        targetResult.error.kind === "unavailable"
      ) {
        note = formatProviderError(target, targetResult.error.message);
      }

      if (available.length === 0) {
        ctx.ui.notify(note ?? NO_AVAILABLE_PROVIDERS_MESSAGE, "info");

        return;
      }

      const lines: string[] = note === undefined ? [] : [note];

      for (const { provider, result, snapshot } of available) {
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

      void refresh(ctx, resolveQuotaProvider(ctx));
      stopTimer();
      refreshTimer = setInterval(() => {
        if (current) {
          void refresh(current.context, current.provider);
        }
      }, REFRESH_INTERVAL_MS);
    },
    refresh: (ctx: ExtensionContext): void => {
      if (ctx.mode === "tui") {
        void refresh(ctx, resolveQuotaProvider(ctx));
      }
    },
  };
};
