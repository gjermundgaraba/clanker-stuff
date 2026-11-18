import { Value } from "typebox/value";

import type { UsageCredential } from "../../auth.js";
import type { FetchJson } from "../../http.js";

export const NOW = Date.parse("2026-07-21T12:00:00.000Z");

export const CODEX_TOKEN = `e30.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "codex-account" },
  })
).toString("base64url")}.signature`;

export const oauthCredential = (token: string): UsageCredential => ({
  token,
  oauth: true,
});

export const okFetch =
  (json: unknown): FetchJson =>
  async (_url, schema) =>
    Value.Check(schema, json)
      ? { json, ok: true }
      : { message: "invalid usage payload", ok: false };
