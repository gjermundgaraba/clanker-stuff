import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/core";
import { z } from "zod/v4";
import type { HttpServerConfig } from "./config.js";

export const AuthorizationMetadataSchema = z.union([
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
]);

const issuer = { issuer: z.string().exactOptional() };

const StateSchema = z.object({
  clientInformation: z
    .union([
      OAuthClientInformationFullSchema.extend(issuer),
      OAuthClientInformationSchema.extend(issuer),
    ])
    .optional(),
  tokens: OAuthTokensSchema.extend(issuer).optional(),
  discoveryState: z
    .object({
      authorizationServerUrl: z.string(),
      authorizationServerMetadata: AuthorizationMetadataSchema.exactOptional(),
      resourceMetadata: OAuthProtectedResourceMetadataSchema.exactOptional(),
      resourceMetadataUrl: z.string().exactOptional(),
    })
    .optional(),
});

export type OAuthState = z.infer<typeof StateSchema>;

export const oauthStatePath = (config: HttpServerConfig): string => {
  const identity = JSON.stringify([
    new URL(config.url).href,
    Object.entries(config.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    {
      clientId: config.oauth?.clientId,
      clientSecret: config.oauth?.clientSecret,
      scopes: config.oauth?.scopes,
      authServerMetadataUrl: config.oauth?.authServerMetadataUrl,
      callbackPort: config.oauth?.callbackPort,
    },
  ]);

  const key = createHash("sha256").update(identity).digest("hex");

  return path.resolve(getExtensionStoragePaths("mcp").dataDir, "oauth", `${key}.json`);
};

/** Cross-process lock; the Pi queue alone cannot serialize refresh-token rotation. */
export const withOAuthLock = async <T>(
  file: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = AbortSignal.timeout(30_000);
  const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const compromised = new AbortController();
  let release: (() => Promise<void>) | undefined;

  while (!release) {
    waiting.throwIfAborted();

    try {
      release = await lockfile.lock(file, {
        realpath: false,
        onCompromised: (error) => compromised.abort(error),
      });
    } catch (error) {
      if (!(error instanceof Object && "code" in error && error.code === "ELOCKED")) throw error;
      await sleep(50, undefined, { signal: waiting });
    }
  }

  try {
    signal?.throwIfAborted();
    const result = await run();
    compromised.signal.throwIfAborted();

    return result;
  } finally {
    await release();
  }
};

export const readOAuthState = async (file: string): Promise<OAuthState> => {
  try {
    return StateSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    if (error instanceof Object && "code" in error && error.code === "ENOENT") return {};
    throw new Error(
      `Cannot read MCP OAuth credentials at ${file}. Fix or remove this file and authorize again.`,
      { cause: error },
    );
  }
};

export const updateOAuthState = async (
  file: string,
  update: (state: OAuthState) => void,
): Promise<void> => {
  await withFileMutationQueue(file, () =>
    withOAuthLock(file, undefined, async () => {
      const state = await readOAuthState(file);
      update(state);
      const temporary = `${file}.${randomUUID()}.tmp`;

      try {
        await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    }),
  );
};
