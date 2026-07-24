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
import type { FooterState } from "./footer.js";
import { renderFooter } from "./footer.js";
import {
  formatDetail,
  formatProviderError,
  formatRefreshFailed,
} from "./format.js";
import type { GitStatus } from "./git.js";
import { readGitStatus, sameGitStatus } from "./git.js";
import type { FetchJson } from "./http.js";
import { defaultFetchJson } from "./http.js";
import { getActiveProvider } from "./providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
} from "./types.js";
import { SUPPORTED_PROVIDERS } from "./types.js";

export interface FooterExtensionDeps {
  fetchJson?: FetchJson;
  discoverCodexBar?: CodexBarDiscover;
  execCodexBar?: CodexBarExec;
  now?: () => number;
  authClientFromContext?: (ctx: ExtensionContext) => ProviderAuthClient;
  runGitStatus?: (cwd: string) => Promise<GitStatus | null>;
}

const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const NO_AVAILABLE_PROVIDERS_MESSAGE =
  "usage: no supported providers are available (log in to a supported provider; opencode-go also requires CodexBar)";

const parseUsageArgs = (
  args: string
): { ok: true; refresh: boolean } | { ok: false; message: string } => {
  const command = args.trim();
  if (command === "") {
    return { ok: true, refresh: false };
  }
  if (command === "refresh") {
    return { ok: true, refresh: true };
  }
  return { message: "usage: expected /usage [refresh]", ok: false };
};

type HttpUsageFetcher = (deps: AdapterDeps) => Promise<UsageFetchResult>;
type UsageFetcher = (ctx: ExtensionContext) => Promise<UsageFetchResult>;

export const createFooterExtension = (deps: FooterExtensionDeps = {}) => {
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

  return (pi: ExtensionAPI) => {
    let generation = 0;
    let footerActive = false;
    let activeProvider: SupportedProvider | undefined;
    let latestUsage: UsageSnapshot | null = null;
    let gitStatus: GitStatus | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let requestRender: (() => void) | undefined;
    let latestCtx: ExtensionContext | undefined;

    const runGitStatus =
      deps.runGitStatus ??
      (async (cwd: string) => await readGitStatus(pi, cwd));

    const rerender = (): void => {
      requestRender?.();
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

    const refreshUsage = (
      ctx: ExtensionContext,
      provider: SupportedProvider | undefined
    ): void => {
      latestCtx = ctx;
      activeProvider = provider;

      if (provider === undefined) {
        latestUsage = null;
        rerender();
        return;
      }

      const gen0 = generation;
      const last = cache.getLastSuccess(provider);
      if (last !== undefined) {
        latestUsage = last;
      }
      rerender();

      void (async () => {
        const result = await getOrFetch(provider, ctx, false);
        if (generation !== gen0 || activeProvider !== provider) {
          return;
        }
        latestUsage = result.ok
          ? result.snapshot
          : (cache.getLastSuccess(provider) ?? null);
        rerender();
      })();
    };

    const refreshGit = async (ctx: ExtensionContext): Promise<void> => {
      const gen0 = generation;
      const next = await runGitStatus(ctx.cwd);
      if (generation !== gen0) {
        return;
      }
      if (!sameGitStatus(gitStatus, next)) {
        gitStatus = next;
        rerender();
      }
    };

    const stopRefreshTimer = (): void => {
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
    };

    const startRefreshTimer = (): void => {
      stopRefreshTimer();
      refreshTimer = setInterval(() => {
        if (latestCtx !== undefined && activeProvider !== undefined) {
          refreshUsage(latestCtx, activeProvider);
        }
      }, USAGE_REFRESH_INTERVAL_MS);
    };

    const buildFooterState = (ctx: ExtensionContext): FooterState => {
      const contextUsage = ctx.getContextUsage();
      return {
        context: {
          percent: contextUsage?.percent ?? 0,
          total: contextUsage?.contextWindow ?? 0,
          used: contextUsage?.tokens ?? 0,
        },
        cwd: ctx.cwd,
        git: gitStatus,
        home: process.env.HOME ?? process.env.USERPROFILE,
        modelName: ctx.model?.id.split("/").pop() ?? "no-model",
        nowMs: now(),
        reasoning: ctx.model?.reasoning ?? false,
        thinkingLevel: pi.getThinkingLevel(),
        usage: latestUsage,
      };
    };

    const installFooter = (ctx: ExtensionContext): void => {
      ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => {
          tui.requestRender();
        };
        const unsubscribe = footerData.onBranchChange(() => {
          void refreshGit(ctx);
        });

        refreshUsage(ctx, getActiveProvider(ctx.model));
        startRefreshTimer();

        return {
          dispose: () => {
            unsubscribe();
            footerActive = false;
            requestRender = undefined;
            stopRefreshTimer();
          },
          // oxlint-disable-next-line eslint/no-empty-function -- stateless component
          invalidate() {},
          render: (width: number): string[] =>
            renderFooter(buildFooterState(ctx), width, theme),
        };
      });
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

      latestCtx = ctx;
      const active = getActiveProvider(ctx.model);

      const results = await Promise.all(
        SUPPORTED_PROVIDERS.map(async (provider) => ({
          provider,
          result: await getOrFetch(provider, ctx, parsed.refresh),
        }))
      );
      const availableResults = results.filter(
        ({ result }) => result.ok || result.error.kind === "failure"
      );
      if (availableResults.length === 0) {
        ctx.ui.notify(NO_AVAILABLE_PROVIDERS_MESSAGE, "info");
        return;
      }

      const lines: string[] = [];
      for (const { provider, result } of availableResults) {
        const snapshot = result.ok
          ? result.snapshot
          : cache.getLastSuccess(provider);

        if (snapshot !== undefined) {
          const [header, ...details] = formatDetail(snapshot, now()).split(
            "\n"
          );
          lines.push([ctx.ui.theme.bold(header ?? ""), ...details].join("\n"));
        }

        if (!result.ok) {
          lines.push(
            snapshot === undefined
              ? formatProviderError(provider, result.error.message)
              : formatRefreshFailed(
                  provider,
                  result.error.message,
                  snapshot.fetchedAt,
                  now()
                )
          );
        }

        if (provider === active) {
          latestUsage = snapshot ?? null;
        }
      }

      rerender();
      ctx.ui.notify(lines.join("\n\n"), "info");
    };

    pi.registerCommand("usage", {
      description:
        "Show remaining subscription usage for all available providers",
      handler: runUsageCommand,
    });

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      if (ctx.mode !== "tui") {
        return;
      }

      footerActive = true;
      latestCtx = ctx;
      installFooter(ctx);
      void refreshGit(ctx);
    });

    pi.on("model_select", (event, ctx) => {
      if (footerActive) {
        refreshUsage(ctx, getActiveProvider(event.model));
      }
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (footerActive) {
        refreshUsage(ctx, getActiveProvider(ctx.model));
      }
    });

    pi.on("turn_end", (_event, ctx) => {
      if (footerActive) {
        void refreshGit(ctx);
      }
    });

    pi.on("thinking_level_select", () => {
      if (footerActive) {
        rerender();
      }
    });

    pi.on("session_shutdown", () => {
      generation += 1;
      footerActive = false;
      stopRefreshTimer();
      activeProvider = undefined;
      latestUsage = null;
      gitStatus = null;
      latestCtx = undefined;
    });
  };
};

export default createFooterExtension();
