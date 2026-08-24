export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "minimax",
  "minimax-cn",
  "kimi-coding",
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

export interface UsageSnapshot {
  provider: SupportedProvider;
  planLabel?: string;
  windows: UsageWindow[];
  creditsRemaining?: number;
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

const NO_WINDOWS_MESSAGE = "no usage windows in response";

export const usageResult = (snapshot: UsageSnapshot): UsageFetchResult => {
  if (snapshot.windows.length === 0) {
    return usageFailure(NO_WINDOWS_MESSAGE);
  }
  return { ok: true, snapshot };
};

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
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "openai-codex": "Codex",
  "opencode-go": "OpenCode Go",
  xai: "Grok",
  zai: "GLM",
} satisfies Record<SupportedProvider, string>;

export const providerDisplayName = (provider: SupportedProvider): string =>
  PROVIDER_DISPLAY_NAMES[provider];
