import { inspectModelHistory, isVirtualModel } from "@clanker-stuff/model-history";
import type { ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openrouter",
  "github-copilot",
  "kimi-coding",
  "radius",
  "xai",
  "zai",
  "opencode-go",
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export type UsageWindowId = "5h" | "day" | "7d" | "week" | "month";

export interface UsageWindow {
  id: UsageWindowId;
  label: string;
  remainingPercent: number;
  resetsAt?: string;
}

export type UsageAccounting =
  | { kind: "credit-balance"; available: number }
  | {
      kind: "radius-billing";
      available: number;
      balance: number;
      reserved: number;
      currentMonthSpend: number;
      periodEndsAt: string;
    };

export interface UsageSnapshot {
  provider: SupportedProvider;
  planLabel?: string;
  quotaWindows: UsageWindow[];
  accounting?: UsageAccounting;
  fetchedAt: number;
}

export interface UsageFetchError {
  message: string;
  kind: "unavailable" | "failure";
}

export type UsageFetchResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; error: UsageFetchError };

export const usageFailure = (
  message: string,
  kind: UsageFetchError["kind"] = "failure",
): UsageFetchResult => ({ error: { kind, message }, ok: false });

export const usageResult = (snapshot: UsageSnapshot): UsageFetchResult =>
  snapshot.quotaWindows.length > 0 || snapshot.accounting !== undefined
    ? { ok: true, snapshot }
    : usageFailure("no usage data in response");

const SUPPORTED_PROVIDER_IDS = new Set<string>(SUPPORTED_PROVIDERS);

export const isSupportedProvider = (provider: string | undefined): provider is SupportedProvider =>
  provider !== undefined && SUPPORTED_PROVIDER_IDS.has(provider);

/** Physical selections target their account; virtual selections follow physical attempts. */
export const resolveQuotaProvider = (
  ctx: Pick<ExtensionContext, "model" | "sessionManager">,
  newest?: MessageEndEvent["message"],
): string | undefined => {
  if (!ctx.model) return undefined;

  if (!isVirtualModel(ctx.model)) return ctx.model.provider;

  return inspectModelHistory(ctx.sessionManager.getBranch(), newest).lastPhysicalAttempt?.provider;
};

/** Unsupported identity is retained until presentation/fetching, rather than mistaken for login failure. */
export const quotaUnavailableMessage = (provider: string | undefined): string =>
  provider === "openai"
    ? "OpenAI subscription quota reporting is unavailable; native authentication has not been verified for a usage endpoint."
    : provider === undefined
      ? "usage: no physical provider resolved for the current model"
      : `usage: quota reporting is unsupported for ${provider}`;

const PROVIDER_DISPLAY_NAMES = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "kimi-coding": "Kimi",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  radius: "Radius",
  xai: "Grok",
  zai: "GLM",
} satisfies Record<SupportedProvider, string>;

export const providerDisplayName = (provider: SupportedProvider): string =>
  PROVIDER_DISPLAY_NAMES[provider];
