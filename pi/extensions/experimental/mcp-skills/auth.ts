import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AuthProvider } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { mcpNamespace } from "./config.js";

const StoredStates = Type.Record(
  Type.String(),
  Type.Object({ tokens: Type.Optional(Type.Object({ access_token: Type.String() })) }),
);

/**
 * Bearer tokens from the OAuth sign-ins Pi stores for its own MCP connections. The token is read
 * again for every request and never refreshed here: Pi refreshes it on its own calls, and a second
 * refresh with the same refresh token could lose the grant. After a 401 the transport retries once
 * with whatever the store holds then.
 */
export const createStoredTokenAuth = (
  agentDir: string,
  name: string,
  url: string,
): AuthProvider => {
  const normalizedUrl = String(new URL(url));
  // Pi looks up OAuth state by namespace and URL, then by URL alone for older sign-ins.
  const keys = [`${mcpNamespace(name)}|${normalizedUrl}`, normalizedUrl];

  return {
    async onUnauthorized() {
      // The retry reads the store again.
    },
    async token() {
      try {
        const states: unknown = JSON.parse(readFileSync(join(agentDir, "mcp-auth.json"), "utf8"));

        if (!Value.Check(StoredStates, states)) return undefined;

        return keys
          .map((key) => states[key]?.tokens?.access_token)
          .find((token) => token !== undefined);
      } catch {
        return undefined;
      }
    },
  };
};

/** Whether a server's headers already carry credentials, so stored OAuth tokens must not be sent. */
export const hasAuthorizationHeader = (headers: Readonly<Record<string, string>>): boolean =>
  Object.keys(headers).some((header) => header.toLowerCase() === "authorization");
