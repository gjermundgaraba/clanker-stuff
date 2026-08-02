export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "google-gemini-cli",
  "minimax",
  "minimax-cn",
  "kimi-coding",
  "xai",
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
  kind: UsageFetchError["kind"] = "failure"
): UsageFetchResult => ({ error: { kind, message }, ok: false });

const NO_WINDOWS_MESSAGE = "no usage windows in response";

export const usageResult = (snapshot: UsageSnapshot): UsageFetchResult => {
  if (snapshot.windows.length === 0) {
    return usageFailure(NO_WINDOWS_MESSAGE);
  }
  return { ok: true, snapshot };
};
