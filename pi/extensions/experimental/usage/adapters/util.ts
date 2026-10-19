import type { Static, TSchema } from "typebox";

import { accessToken } from "../auth.js";
import type { GetAuth } from "../auth.js";
import type { FetchJson } from "../http.js";
import { usageFailure } from "../providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageWindow,
  UsageWindowId,
} from "../providers.js";

export interface AdapterDeps {
  getAuth: GetAuth;
  fetchJson: FetchJson;
  now: () => number;
}

export interface UsageRequest<S extends TSchema> {
  url: string;
  schema: S;
  /** Subscription usage: API-key credentials are unavailable without a request. */
  oauth?: boolean;
  /** Authorization scheme; GitHub's Copilot endpoint uses `token`. */
  scheme?: "Bearer" | "token";
  headers?: Record<string, string>;
}

/**
 * GET an authenticated usage endpoint and map its checked payload. A 403
 * means the credential lacks this entitlement, so the provider is unavailable
 * rather than broken.
 */
export const fetchUsage = async <S extends TSchema>(
  deps: AdapterDeps,
  provider: SupportedProvider,
  request: UsageRequest<S>,
  map: (payload: Static<S>, nowMs: number) => UsageFetchResult,
): Promise<UsageFetchResult> => {
  const auth = await accessToken(deps.getAuth, provider, { oauth: request.oauth ?? false });

  if (!auth.ok) return auth;

  const response = await deps.fetchJson(request.url, request.schema, {
    Accept: "application/json",
    Authorization: `${request.scheme ?? "Bearer"} ${auth.token}`,
    ...request.headers,
  });

  if (response.ok) {
    return map(response.json, deps.now());
  }

  return usageFailure(response.message, response.status === 403 ? "unavailable" : "failure");
};

export const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export const makeUsageWindow = (
  id: UsageWindowId,
  remainingPercent: number,
  resetsAt?: string,
  label: string = id,
): UsageWindow => {
  const usageWindow: UsageWindow = {
    id,
    label,
    remainingPercent: clampPercent(remainingPercent),
  };

  if (resetsAt !== undefined) {
    usageWindow.resetsAt = resetsAt;
  }

  return usageWindow;
};

export const parseIso = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
};
