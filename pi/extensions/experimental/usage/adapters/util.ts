import type { Static, TSchema } from "typebox";

import { accessToken } from "../auth.js";
import type { GetAuth } from "../auth.js";
import type { FetchJson, FetchJsonResult } from "../http.js";
import { usageFailure } from "../providers.js";
import type {
  SupportedProvider,
  UsageFetchFailure,
  UsageFetchResult,
  UsageWindow,
} from "../providers.js";

export interface AdapterDeps {
  getAuth: GetAuth;
  fetchJson: FetchJson;
  now: () => number;
}

export interface UsageAuth {
  oauth?: boolean;
  /** Authorization scheme; GitHub's Copilot endpoint uses `token`. */
  scheme?: "Bearer" | "token";
  headers?: (token: string) => Record<string, string>;
}

export interface UsageRequest<S extends TSchema> extends UsageAuth {
  url: string;
  schema: S;
}

/** Request headers carrying the provider's credential, or why it cannot be used. */
export const usageHeaders = async (
  deps: AdapterDeps,
  provider: SupportedProvider,
  auth: UsageAuth
): Promise<
  { ok: true; headers: Record<string, string> } | UsageFetchFailure
> => {
  const token = await accessToken(deps.getAuth, provider, {
    oauth: auth.oauth ?? false,
  });

  if (!token.ok) {
    return token;
  }

  return {
    ok: true,
    headers: {
      Accept: "application/json",
      Authorization: `${auth.scheme ?? "Bearer"} ${token.token}`,
      ...auth.headers?.(token.token),
    },
  };
};

/** A 403 means the credential lacks this entitlement, so the provider is unavailable rather than broken. */
export const responseFailure = ({
  message,
  status,
}: Extract<FetchJsonResult<unknown>, { ok: false }>): UsageFetchFailure =>
  usageFailure(message, status === 403 ? "unavailable" : "failure");

export const fetchUsage = async <S extends TSchema>(
  deps: AdapterDeps,
  provider: SupportedProvider,
  request: UsageRequest<S>,
  map: (payload: Static<S>, nowMs: number) => UsageFetchResult
): Promise<UsageFetchResult> => {
  const auth = await usageHeaders(deps, provider, request);

  if (!auth.ok) {
    return auth;
  }

  const response = await deps.fetchJson(
    request.url,
    request.schema,
    auth.headers
  );

  return response.ok
    ? map(response.json, deps.now())
    : responseFailure(response);
};

export const isDefined = <T>(value: T | undefined): value is T =>
  value !== undefined;

const clampPercent = (value: number): number =>
  Math.min(100, Math.max(0, value));

export const makeUsageWindow = (
  label: string,
  remainingPercent: number,
  resetsAt?: string
): UsageWindow => {
  const usageWindow: UsageWindow = {
    label,
    remainingPercent: clampPercent(remainingPercent),
  };

  if (resetsAt !== undefined) {
    usageWindow.resetsAt = resetsAt;
  }

  return usageWindow;
};

export const durationLabel = (seconds: number): string => {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }

  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
};

export const isoFromEpochMs = (
  value: number | undefined
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
