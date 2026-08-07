import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { VoiceAuth } from "./realtime.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const accountIdFromAccessToken = (accessToken: string): string => {
  try {
    const parts = accessToken.split(".");
    const [, encodedPayload] = parts;
    if (parts.length !== 3 || !encodedPayload) {
      throw new Error("not a JWT");
    }
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf-8")
    );
    if (!isRecord(payload)) {
      throw new Error("invalid JWT payload");
    }
    const auth = payload["https://api.openai.com/auth"];
    const accountId =
      auth !== null &&
      typeof auth === "object" &&
      "chatgpt_account_id" in auth &&
      typeof auth.chatgpt_account_id === "string"
        ? auth.chatgpt_account_id
        : undefined;
    if (accountId === undefined || accountId.length === 0) {
      throw new Error("account ID missing");
    }
    return accountId;
  } catch {
    throw new Error(
      "OpenAI Codex OAuth token does not contain a ChatGPT account ID."
    );
  }
};

export const validateCoordinator = async (
  ctx: ExtensionContext
): Promise<void> => {
  if (!ctx.model) {
    throw new Error("Select a Pi coordinator model before starting voice.");
  }
  const { id, provider } = ctx.model;
  const model = ctx.modelRegistry
    .getAll()
    .find(
      (candidate) => candidate.provider === provider && candidate.id === id
    );
  if (!model) {
    throw new Error("The selected Pi coordinator model is unavailable.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
};

export const resolveVoiceAuth = async (
  ctx: ExtensionContext
): Promise<VoiceAuth> => {
  const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
  const accessToken = result?.auth.apiKey;
  if (accessToken === undefined || accessToken.length === 0) {
    throw new Error(
      "OpenAI Codex OAuth is not configured. Run /login and choose OpenAI Codex."
    );
  }
  return {
    accessToken,
    accountId: accountIdFromAccessToken(accessToken),
  };
};
