import { Value } from "typebox/value";
import type { ProviderAuthClient } from "../../auth.js";
import type { FetchJson } from "../../http.js";

export const NOW = Date.parse("2026-07-21T12:00:00.000Z");

export const absent = async <T = never>(): Promise<T | undefined> => undefined;

export const tokenAuthClient = (token: string): ProviderAuthClient => ({
  getProviderAuth: async () => ({
    auth: { apiKey: token },
    source: "OAuth",
  }),
});

export const okFetch =
  (json: unknown): FetchJson =>
  async (_url, schema) =>
    Value.Check(schema, json)
      ? { json, ok: true }
      : { kind: "payload", message: "invalid usage payload", ok: false };
