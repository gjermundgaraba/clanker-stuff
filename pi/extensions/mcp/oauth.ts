import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthServerInfo,
  OAuthClientMetadata,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
  AuthorizationServerMetadata,
} from "@modelcontextprotocol/client";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod/v4";

import type { HttpOAuthAuthorizationCodeConfig } from "./config.js";

const OAUTH_STATE_FILE = "mcp-oauth.json";
const DEFAULT_REDIRECT_PORT = 33_418;
const CALLBACK_PATH = "/callback";
const CALLBACK_HOST = "localhost";

const AuthorizationServerMetadataSchema = z.union([
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
]);

const DiscoveryStateSchema = z.object({
  authorizationServerMetadata: AuthorizationServerMetadataSchema.optional(),
  authorizationServerUrl: z.string(),
  resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
  resourceMetadataUrl: z.string().optional(),
});

// SEP-2352: the SDK stamps `issuer` on credentials before persisting them and
// warns when a read comes back without it. The core wire schemas strip unknown
// fields, so storage schemas must re-add `issuer` to round-trip the stamp.
const issuerStampShape = { issuer: z.string().optional() };

const StoredServerOAuthStateSchema = z.object({
  clientInformation: z
    .union([
      OAuthClientInformationFullSchema.extend(issuerStampShape),
      OAuthClientInformationSchema.extend(issuerStampShape),
    ])
    .optional(),
  codeVerifier: z.string().min(1).optional(),
  discoveryState: DiscoveryStateSchema.optional(),
  tokens: OAuthTokensSchema.extend(issuerStampShape).optional(),
});

const StoredOAuthStateSchema = z.object({
  servers: z.record(z.string(), StoredServerOAuthStateSchema),
});

type StoredServerOAuthState = z.infer<typeof StoredServerOAuthStateSchema>;
type StoredOAuthState = z.infer<typeof StoredOAuthStateSchema>;

const getOAuthStatePath = (): string =>
  path.join(getExtensionStoragePaths("mcp").dataDir, OAUTH_STATE_FILE);

const parseStoredOAuthState = (value: unknown): StoredOAuthState => {
  const result = StoredOAuthStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error("invalid MCP OAuth state", { cause: result.error });
  }
  return result.data;
};

const fetchAuthorizationServerMetadata = async (
  url: string
): Promise<AuthorizationServerMetadata> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch OAuth authorization server metadata: ${response.status} ${response.statusText}`
    );
  }
  return AuthorizationServerMetadataSchema.parse(await response.json());
};

export const startOAuthCallbackServer = async (
  redirectUrl: URL,
  expectedState: string
): Promise<OAuthCallbackServer> => {
  const {
    promise: codePromise,
    resolve: resolveCode,
    reject: rejectCode,
  } = Promise.withResolvers<string>();

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);
    if (requestUrl.pathname !== redirectUrl.pathname) {
      res.writeHead(404).end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error !== null && error !== "") {
      res.writeHead(400).end("OAuth failed. You can close this tab.");
      rejectCode(new Error(`MCP OAuth failed: ${error}`));
      return;
    }

    const state = requestUrl.searchParams.get("state");
    if (state !== expectedState) {
      res.writeHead(400).end("Invalid OAuth state.");
      rejectCode(new Error("MCP OAuth callback state mismatch"));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (code === null || code === "") {
      res.writeHead(400).end("Missing OAuth code.");
      rejectCode(new Error("MCP OAuth callback did not include a code"));
      return;
    }

    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("MCP authorization complete. You can close this tab.");
    resolveCode(code);
  });

  // Real callers still observe this promise; this only prevents an unhandled rejection.
  // oxlint-disable-next-line promise/prefer-await-to-then -- Must attach to the original promise.
  void codePromise.catch(() => null);

  server.listen(Number(redirectUrl.port), redirectUrl.hostname);
  await once(server, "listening");
  server.on("error", rejectCode);

  return {
    close: async () => {
      if (!server.listening) {
        return;
      }
      server.close();
      await once(server, "close");
    },
    waitForCode: async (signal?: AbortSignal) => {
      if (signal === undefined) {
        return await codePromise;
      }
      signal.throwIfAborted();
      return await Promise.race([
        codePromise,
        once(signal, "abort").then(() => {
          throw new Error("MCP OAuth authorization was cancelled");
        }),
      ]);
    },
  };
};

const writeOAuthState = async (state: StoredOAuthState): Promise<void> => {
  const filePath = getOAuthStatePath();
  await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
};

const readOAuthState = async (): Promise<StoredOAuthState> => {
  try {
    const contents = await readFile(getOAuthStatePath(), "utf-8");
    return parseStoredOAuthState(JSON.parse(contents));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { servers: {} };
    }
    throw error;
  }
};

const readServerState = async (
  serverName: string
): Promise<StoredServerOAuthState | undefined> => {
  const state = await readOAuthState();
  return state.servers[serverName];
};

const updateServerState = async (
  serverName: string,
  update: (state: StoredServerOAuthState) => void
): Promise<void> => {
  const filePath = getOAuthStatePath();
  await withFileMutationQueue(filePath, async () => {
    const state = await readOAuthState();
    const serverState = state.servers[serverName] ?? {};
    update(serverState);
    state.servers[serverName] = serverState;
    await writeOAuthState(state);
  });
};

export class PersistentMcpOAuthProvider implements OAuthClientProvider {
  private readonly redirectUrlValue: URL;
  private readonly stateValue = randomUUID();
  private readonly serverName: string;
  private readonly config: HttpOAuthAuthorizationCodeConfig;
  private readonly onAuthorizationUrl: (url: URL) => void;

  constructor(
    serverName: string,
    config: HttpOAuthAuthorizationCodeConfig,
    onAuthorizationUrl: (url: URL) => void
  ) {
    this.serverName = serverName;
    this.config = config;
    this.onAuthorizationUrl = onAuthorizationUrl;
    this.redirectUrlValue = new URL(
      `http://${CALLBACK_HOST}:${config.callbackPort ?? DEFAULT_REDIRECT_PORT}${CALLBACK_PATH}`
    );
  }

  get redirectUrl(): URL {
    return this.redirectUrlValue;
  }

  get expectedState(): string {
    return this.stateValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? "pi MCP",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl.toString()],
      response_types: ["code"],
      scope: this.config.scopes,
      token_endpoint_auth_method:
        typeof this.config.clientSecret === "string" &&
        this.config.clientSecret !== ""
          ? "client_secret_post"
          : undefined,
    };
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (
      typeof this.config.clientId === "string" &&
      this.config.clientId !== ""
    ) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      };
    }
    const serverState = await readServerState(this.serverName);
    return serverState?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation
  ): Promise<void> {
    if (
      typeof this.config.clientId === "string" &&
      this.config.clientId !== ""
    ) {
      return;
    }
    await updateServerState(this.serverName, (state) => {
      state.clientInformation = clientInformation;
    });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const serverState = await readServerState(this.serverName);
    return serverState?.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await updateServerState(this.serverName, (state) => {
      state.tokens = tokens;
    });
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery"
  ): Promise<void> {
    await updateServerState(this.serverName, (state) => {
      if (scope === "all" || scope === "client") {
        delete state.clientInformation;
      }
      if (scope === "all" || scope === "tokens") {
        delete state.tokens;
      }
      if (scope === "all" || scope === "verifier") {
        delete state.codeVerifier;
      }
      if (scope === "all" || scope === "discovery") {
        delete state.discoveryState;
      }
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateServerState(this.serverName, (state) => {
      state.codeVerifier = codeVerifier;
    });
  }

  async codeVerifier(): Promise<string> {
    const serverState = await readServerState(this.serverName);
    const codeVerifier = serverState?.codeVerifier;
    if (typeof codeVerifier !== "string" || codeVerifier === "") {
      throw new Error("No MCP OAuth code verifier saved");
    }
    return codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateServerState(this.serverName, (serverState) => {
      serverState.discoveryState = state;
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (
      typeof this.config.authServerMetadataUrl === "string" &&
      this.config.authServerMetadataUrl !== ""
    ) {
      const metadata = await fetchAuthorizationServerMetadata(
        this.config.authServerMetadataUrl
      );
      return {
        authorizationServerMetadata: metadata,
        authorizationServerUrl: metadata.issuer,
      } satisfies OAuthServerInfo;
    }
    const serverState = await readServerState(this.serverName);
    return serverState?.discoveryState;
  }
}

export interface OAuthCallbackServer {
  waitForCode: (signal?: AbortSignal) => Promise<string>;
  close: () => Promise<void>;
}
