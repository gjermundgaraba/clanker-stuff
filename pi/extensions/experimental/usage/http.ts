import { fetchCodexHttp } from "@clanker-stuff/codex-http";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export const USAGE_HTTP_TIMEOUT_MS = 12_000;

export interface FetchJsonSuccess<T> {
  ok: true;
  json: T;
}

export interface FetchJsonFailure {
  ok: false;
  kind: "response" | "payload";
  message: string;
}

export type FetchJsonResult<T> = FetchJsonSuccess<T> | FetchJsonFailure;

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: string;
}

export type FetchJson = <S extends TSchema>(
  url: string,
  schema: S,
  options: FetchJsonOptions,
) => Promise<FetchJsonResult<Static<S>>>;

export const defaultFetchJson: FetchJson = async (url, schema, options) => {
  const signal = AbortSignal.timeout(options.timeoutMs);

  try {
    const response = await fetchCodexHttp(url, {
      body: options.body,
      headers: options.headers,
      method: options.method ?? "GET",
      signal,
    });

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        message: "auth rejected by usage API",
        kind: "response",
        ok: false,
      };
    }
    if (!response.ok) {
      return {
        message: `HTTP ${response.status}`,
        kind: "response",
        ok: false,
      };
    }

    try {
      const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;
      return Value.Check(schema, json)
        ? { json, ok: true }
        : { kind: "payload", message: "invalid usage payload", ok: false };
    } catch {
      return {
        message: "invalid JSON response",
        kind: "response",
        ok: false,
      };
    }
  } catch (error) {
    if (signal.aborted) {
      return { kind: "response", message: "request timed out", ok: false };
    }
    const message = error instanceof Error ? error.message : "network request failed";
    return { kind: "response", message, ok: false };
  }
};
