import type { AuthResult } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { usageFailure } from "./providers.js";
import type { SupportedProvider, UsageFetchFailure } from "./providers.js";

export type GetAuth = (provider: SupportedProvider) => Promise<AuthResult | undefined>;

/**
 * Pi's request auth for each provider. Copilot's resolves to the Copilot session token, which the
 * usage endpoint rejects, so a stored login uses its GitHub token instead.
 */
export const contextAuth =
  (
    ctx: { modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth"> },
    readCredential: typeof readStoredCredential = readStoredCredential,
  ): GetAuth =>
  async (provider) => {
    if (provider === "github-copilot") {
      const credential = readCredential(provider);

      if (credential?.type === "oauth" && credential.refresh.length > 0)
        return { auth: { apiKey: credential.refresh }, source: "OAuth" };
    }

    return await ctx.modelRegistry.getProviderAuth(provider);
  };

/**
 * The credential to send to a usage endpoint. Subscription endpoints (`oauth`) are unavailable
 * with API keys rather than failing, so API-key users are not shown a failure on every refresh.
 */
export const accessToken = async (
  getAuth: GetAuth,
  provider: SupportedProvider,
  { oauth = false }: { oauth?: boolean } = {},
): Promise<{ ok: true; token: string } | UsageFetchFailure> => {
  let auth: AuthResult | undefined;

  try {
    auth = await getAuth(provider);
  } catch {
    // An expired OAuth login whose refresh fails is not logged in for usage purposes.
    auth = undefined;
  }

  const token = auth?.auth.apiKey;

  if (token === undefined || token.length === 0)
    return usageFailure("not logged in", "unavailable");

  if (oauth && auth?.source !== "OAuth")
    return usageFailure("subscription usage requires OAuth login (not API key)", "unavailable");

  return { ok: true, token };
};
