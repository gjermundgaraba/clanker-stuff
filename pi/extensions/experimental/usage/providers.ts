export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai-codex",
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
  ordinaryUsageAllowed?: boolean;
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
  snapshot.quotaWindows.length > 0 ||
  snapshot.accounting !== undefined ||
  snapshot.ordinaryUsageAllowed !== undefined
    ? { ok: true, snapshot }
    : usageFailure("no usage data in response");

const SUPPORTED_PROVIDER_IDS = new Set<string>(SUPPORTED_PROVIDERS);

const isSupportedProvider = (provider: string | undefined): provider is SupportedProvider =>
  provider !== undefined && SUPPORTED_PROVIDER_IDS.has(provider);

export const getActiveProvider = (
  model: { provider?: string } | undefined | null,
): SupportedProvider | undefined => {
  const provider = model?.provider;

  return isSupportedProvider(provider) ? provider : undefined;
};

const PROVIDER_DISPLAY_NAMES = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "kimi-coding": "Kimi",
  "openai-codex": "Codex",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  radius: "Radius",
  xai: "Grok",
  zai: "GLM",
} satisfies Record<SupportedProvider, string>;

export const providerDisplayName = (provider: SupportedProvider): string =>
  PROVIDER_DISPLAY_NAMES[provider];
