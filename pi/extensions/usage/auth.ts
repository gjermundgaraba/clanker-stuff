import type { Credential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SupportedProvider, UsageFetchError } from "./providers.js";

interface ResolvedAccess {
  accessToken: string;
}

type AuthResolution<T = ResolvedAccess> =
  | { ok: true; value: T }
  | { ok: false; kind: UsageFetchError["kind"]; message: string };

interface AuthLike {
  auth?: { apiKey?: string };
  source?: string;
}

interface ResolvedAuth extends ResolvedAccess {
  source?: string;
}

export interface ProviderAuthClient {
  getProviderAuth: (provider: string) => Promise<AuthLike | undefined>;
}

const resolveAuth = async (
  client: ProviderAuthClient,
  provider: SupportedProvider,
): Promise<AuthResolution<ResolvedAuth>> => {
  let auth: AuthLike | undefined;
  try {
    auth = await client.getProviderAuth(provider);
  } catch {
    return {
      kind: "unavailable",
      message: "not logged in",
      ok: false,
    };
  }

  const accessToken = auth?.auth?.apiKey;
  const source = auth?.source;
  if (accessToken === undefined || accessToken.length === 0) {
    return {
      kind: "unavailable",
      message: "not logged in",
      ok: false,
    };
  }

  return {
    ok: true,
    value: source === undefined ? { accessToken } : { accessToken, source },
  };
};

export const resolveAccessToken = async (
  client: ProviderAuthClient,
  provider: SupportedProvider,
): Promise<AuthResolution> => {
  const resolved = await resolveAuth(client, provider);
  return resolved.ok ? { ok: true, value: { accessToken: resolved.value.accessToken } } : resolved;
};

export const resolveOAuthAccess = async (
  client: ProviderAuthClient,
  provider: SupportedProvider,
): Promise<AuthResolution> => {
  const resolved = await resolveAuth(client, provider);
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value.source !== "OAuth") {
    return {
      kind: "unavailable",
      message: "subscription usage requires OAuth login (not API key)",
      ok: false,
    };
  }

  return {
    ok: true,
    value: { accessToken: resolved.value.accessToken },
  };
};

interface ProviderAuthContext {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
}

type StoredCredentialReader = (provider: string) => Credential | undefined;

export const providerAuthClientFromContext = (
  ctx: ProviderAuthContext,
  readCredential: StoredCredentialReader = readStoredCredential,
): ProviderAuthClient => ({
  getProviderAuth: async (provider) => {
    if (provider === "github-copilot") {
      const credential = readCredential(provider);
      if (credential?.type === "oauth" && credential.refresh.length > 0) {
        return {
          auth: { apiKey: credential.refresh },
          source: "OAuth",
        };
      }
    }
    return await ctx.modelRegistry.getProviderAuth(provider);
  },
});
