import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

const USAGE_HTTP_TIMEOUT_MS = 12_000;

export type FetchJsonResult<T> =
  | { ok: true; json: T }
  | {
      ok: false;
      kind: "response" | "payload";
      message: string;
      status?: number;
    };

export type FetchJson = <S extends TSchema>(
  url: string,
  schema: S,
  headers: Record<string, string>
) => Promise<FetchJsonResult<Static<S>>>;

const HttpErrorMessageSchema = Type.Object({
  error: Type.Object({
    message: Type.String({ minLength: 1 }),
  }),
});

const messageFromErrorBody = (text: string): string | undefined => {
  try {
    const json: unknown = JSON.parse(text);

    return Value.Check(HttpErrorMessageSchema, json)
      ? json.error.message
      : undefined;
  } catch {
    return undefined;
  }
};

export const defaultFetchJson: FetchJson = async (url, schema, headers) => {
  const signal = AbortSignal.timeout(USAGE_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, { headers, signal });
    const text = await response.text();

    if (!response.ok) {
      return {
        kind: "response",
        message: messageFromErrorBody(text) ?? `HTTP ${response.status}`,
        ok: false,
        status: response.status,
      };
    }

    try {
      const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;

      return Value.Check(schema, json)
        ? { json, ok: true }
        : { kind: "payload", message: "invalid usage payload", ok: false };
    } catch {
      return {
        kind: "response",
        message: "invalid JSON response",
        ok: false,
      };
    }
  } catch (error) {
    if (signal.aborted) {
      return { kind: "response", message: "request timed out", ok: false };
    }

    const message =
      error instanceof Error ? error.message : "network request failed";

    return { kind: "response", message, ok: false };
  }
};
