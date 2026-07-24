import type { SupportedProvider } from "./types.js";
import { SUPPORTED_PROVIDERS } from "./types.js";

const isSupportedProvider = (
  provider: string | undefined
): provider is SupportedProvider =>
  provider !== undefined &&
  (SUPPORTED_PROVIDERS as readonly string[]).includes(provider);

export const getActiveProvider = (
  model: { provider?: string } | undefined | null
): SupportedProvider | undefined => {
  const provider = model?.provider;
  return isSupportedProvider(provider) ? provider : undefined;
};

const PROVIDER_DISPLAY_NAMES = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini",
  "kimi-coding": "Kimi",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "openai-codex": "Codex",
  "opencode-go": "OpenCode Go",
  xai: "Grok",
} satisfies Record<SupportedProvider, string>;

export const providerDisplayName = (provider: SupportedProvider): string =>
  PROVIDER_DISPLAY_NAMES[provider];
