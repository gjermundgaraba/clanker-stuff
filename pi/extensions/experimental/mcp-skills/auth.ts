import { readFileSync } from "node:fs";
import path from "node:path";

import type { AuthProvider } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { mcpNamespace } from "./config.js";

const StoredStates = Type.Record(
  Type.String(),
  Type.Object({
    tokens: Type.Optional(Type.Object({ access_token: Type.String() })),
  })
);

export const createStoredTokenAuth = (
  agentDir: string,
  name: string,
  url: string
): AuthProvider => {
  const normalizedUrl = String(new URL(url));
  const keys = [`${mcpNamespace(name)}|${normalizedUrl}`, normalizedUrl];

  return {
    onUnauthorized: async () => undefined,
    async token(): Promise<string | undefined> {
      try {
        const states: unknown = JSON.parse(
          readFileSync(path.join(agentDir, "mcp-auth.json"), "utf-8")
        );

        if (!Value.Check(StoredStates, states)) {
          return undefined;
        }

        return keys
          .map((key) => states[key]?.tokens?.access_token)
          .find((token) => token !== undefined);
      } catch {
        return undefined;
      }
    },
  };
};

export const hasAuthorizationHeader = (
  headers: Readonly<Record<string, string>>
): boolean =>
  Object.keys(headers).some(
    (header) => header.toLowerCase() === "authorization"
  );
