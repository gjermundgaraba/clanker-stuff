import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import {
  auth,
  InsufficientScopeError,
  extractWWWAuthenticateParams,
  UnauthorizedError,
  SdkHttpError,
} from "@modelcontextprotocol/client";
import type {
  AuthProvider,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthClientMetadata,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { HttpServerConfig } from "./config.js";
import { awaitWithSignal } from "./abort.js";
import {
  AuthorizationMetadataSchema,
  oauthStatePath,
  readOAuthState,
  updateOAuthState,
  withOAuthLock,
} from "./oauth-store.js";

const oauthFetch =
  (signal?: AbortSignal): typeof fetch =>
  (input, init) => {
    const signals = [AbortSignal.timeout(30_000)];
    if (signal) signals.push(signal);
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    return fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };

export const isAuthorizationError = (cause: unknown): boolean =>
  UnauthorizedError.isInstance(cause) ||
  cause instanceof InsufficientScopeError ||
  (SdkHttpError.isInstance(cause) && cause.status === 401);

const requestedScopes = (...scopes: (string | undefined)[]): string | undefined => {
  const words = scopes.flatMap((scope) => scope?.split(/\s+/u).filter(Boolean) ?? []);
  return [...new Set(words)].join(" ") || undefined;
};

export const startOAuthCallbackServer = async (redirectUrl: URL, expectedState: string) => {
  const code = Promise.withResolvers<{ code: string; iss?: string }>();
  // Requests can arrive before waitForCode attaches its rejection handler.
  void code.promise.catch(() => {});
  const server = createServer((req, res) => {
    const url = URL.parse(req.url ?? "/", redirectUrl);
    if (!url) {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname !== redirectUrl.pathname) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== expectedState) {
      // Unrelated local requests must not cancel a legitimate authorization attempt.
      res.writeHead(400).end("Invalid OAuth state.");
      return;
    }
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("code");
    if (error || !value) {
      res.writeHead(400).end("Authorization failed. You can close this tab.");
      code.reject(new Error(error ? `MCP OAuth failed: ${error}` : "Missing OAuth code"));
      return;
    }
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("MCP authorization complete. You can close this tab.");
    code.resolve({ code: value, iss: url.searchParams.get("iss") ?? undefined });
  });
  server.listen(Number(redirectUrl.port), redirectUrl.hostname);
  await once(server, "listening");
  server.on("error", code.reject);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("OAuth listener has no TCP address");
  const boundUrl = new URL(redirectUrl);
  boundUrl.port = String(address.port);
  return {
    redirectUrl: boundUrl,
    waitForCode: (signal?: AbortSignal) => awaitWithSignal(code.promise, signal),
    close: async () => {
      if (!server.listening) return;
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
};

export class PersistentMcpOAuthProvider implements OAuthClientProvider {
  readonly statePath: string;
  private readonly expectedState = randomUUID();
  redirectUrl: URL;
  authorizationUrl?: URL;
  private verifier?: string;
  private authorizationClient?: StoredOAuthClientInformation;
  private discovery?: OAuthDiscoveryState;
  private readonly config: NonNullable<HttpServerConfig["oauth"]>;
  private fetcher: typeof fetch = oauthFetch();

  constructor(serverConfig: HttpServerConfig) {
    this.config = serverConfig.oauth ?? {};
    this.statePath = oauthStatePath(serverConfig);
    this.redirectUrl = new URL(`http://localhost:${this.config.callbackPort ?? 0}/callback`);
  }

  setFetch(fetcher: typeof fetch): void {
    this.fetcher = fetcher;
  }
  state(): string {
    return this.expectedState;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? "pi MCP",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl.href],
      response_types: ["code"],
      scope: this.config.scopes,
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    };
  }
  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (this.authorizationClient) return this.authorizationClient;
    const stored = (await readOAuthState(this.statePath)).clientInformation;
    if (stored) return stored;
    if (this.config.clientId)
      return { client_id: this.config.clientId, client_secret: this.config.clientSecret };
    return undefined;
  }
  async saveClientInformation(value: StoredOAuthClientInformation): Promise<void> {
    await updateOAuthState(this.statePath, (state) => {
      state.clientInformation = value;
    });
  }
  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await readOAuthState(this.statePath)).tokens;
  }
  async saveTokens(value: StoredOAuthTokens): Promise<void> {
    await updateOAuthState(this.statePath, (state) => {
      state.tokens = value;
      if (this.authorizationClient) {
        state.clientInformation = this.authorizationClient;
        state.discoveryState = this.discovery;
      }
    });
  }
  clearHandshake(): void {
    this.verifier = undefined;
    this.authorizationClient = undefined;
    this.discovery = undefined;
    this.authorizationUrl = undefined;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "client" || scope === "verifier")
      this.authorizationClient = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
    if (scope === "verifier") return;
    await updateOAuthState(this.statePath, (state) => {
      if (scope === "all" || scope === "client") delete state.clientInformation;
      if (scope === "all" || scope === "tokens") delete state.tokens;
      if (scope === "all" || scope === "discovery") delete state.discoveryState;
    });
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }
  async saveCodeVerifier(value: string): Promise<void> {
    // Keep the registration paired with this PKCE handshake while other processes authorize.
    this.authorizationClient = await this.clientInformation();
    this.verifier = value;
  }
  codeVerifier(): string {
    if (!this.verifier) throw new Error("No MCP OAuth code verifier saved");
    return this.verifier;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.discovery = value;
    await updateOAuthState(this.statePath, (state) => {
      state.discoveryState = value;
    });
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.discovery) return this.discovery;
    this.discovery = (await readOAuthState(this.statePath)).discoveryState;
    if (!this.discovery && this.config.authServerMetadataUrl) {
      const response = await this.fetcher(this.config.authServerMetadataUrl);
      if (!response.ok) throw new Error(`OAuth metadata request failed: ${response.status}`);
      const metadata = AuthorizationMetadataSchema.parse(await response.json());
      this.discovery = {
        authorizationServerUrl: metadata.issuer,
        authorizationServerMetadata: metadata,
      };
    }
    return this.discovery;
  }

  async prepareRedirect(url: URL): Promise<void> {
    this.redirectUrl = url;
    // A dynamically registered client may have an exact redirect URI. Register it again for a new port.
    const stored = (await readOAuthState(this.statePath)).clientInformation;
    if (
      !this.config.clientId &&
      stored &&
      "redirect_uris" in stored &&
      !stored.redirect_uris.includes(url.href)
    ) {
      await this.invalidateCredentials("client");
    }
  }
}

/** Adapter keeps SDK OAuth logic, but owns refresh serialization and the explicit browser boundary. */
export const createHttpAuth = (serverConfig: HttpServerConfig) => {
  const provider = new PersistentMcpOAuthProvider(serverConfig);
  let lastToken: string | undefined;
  let challenge: ReturnType<typeof extractWWWAuthenticateParams> = {};
  let operationSignal: AbortSignal | undefined;
  const authProvider: AuthProvider = {
    token: async () => {
      lastToken = (await provider.tokens())?.access_token;
      return lastToken;
    },
    onUnauthorized: async ({ response }) => {
      const rejectedToken = lastToken;
      challenge = extractWWWAuthenticateParams(response);
      await withOAuthLock(`${provider.statePath}.auth`, operationSignal, async () => {
        const current = await provider.tokens();
        if (current?.access_token && current.access_token !== rejectedToken) return;
        if (!current?.refresh_token)
          throw new UnauthorizedError(
            "MCP authorization required. Reconnect with /mcp or mcp_connect.",
          );
        const fetchFn = oauthFetch(operationSignal);
        provider.setFetch(fetchFn);
        const result = await auth(provider, {
          serverUrl: serverConfig.url,
          ...challenge,
          scope: requestedScopes(serverConfig.oauth?.scopes, challenge.scope),
          fetchFn,
        });
        if (result === "REDIRECT")
          throw new UnauthorizedError(
            "MCP authorization required. Reconnect with /mcp or mcp_connect.",
          );
      });
    },
  };
  return {
    authProvider,
    setSignal: (signal?: AbortSignal) => {
      operationSignal = signal;
    },
    authorize: async (
      notifyUrl: (url: URL) => void,
      signal?: AbortSignal,
      scopeError?: InsufficientScopeError,
    ) => {
      signal?.throwIfAborted();
      if (scopeError)
        challenge = {
          scope: scopeError.requiredScope,
          resourceMetadataUrl: scopeError.resourceMetadataUrl,
        };
      provider.clearHandshake();
      const callback = await startOAuthCallbackServer(provider.redirectUrl, provider.state());
      try {
        const fetchFn = oauthFetch(signal);
        provider.setFetch(fetchFn);
        const result = await withOAuthLock(`${provider.statePath}.auth`, signal, async () => {
          await provider.prepareRedirect(callback.redirectUrl);
          return await auth(provider, {
            serverUrl: serverConfig.url,
            ...challenge,
            scope: requestedScopes(serverConfig.oauth?.scopes, challenge.scope),
            fetchFn,
            forceReauthorization: true,
          });
        });
        const authorizationUrl = provider.authorizationUrl;
        if (result !== "REDIRECT" || !authorizationUrl)
          throw new Error("MCP OAuth did not redirect to an authorization URL");
        notifyUrl(authorizationUrl);
        const { code, iss } = await callback.waitForCode(signal);
        await withOAuthLock(`${provider.statePath}.auth`, signal, () =>
          auth(provider, {
            serverUrl: serverConfig.url,
            authorizationCode: code,
            iss,
            scope: requestedScopes(serverConfig.oauth?.scopes, challenge.scope),
            fetchFn,
          }),
        );
      } finally {
        provider.clearHandshake();
        await callback.close();
      }
    },
  };
};
