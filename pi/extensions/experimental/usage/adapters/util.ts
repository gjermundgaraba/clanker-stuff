import type { Static, TSchema } from "typebox";

import { resolveAccessToken } from "../auth.js";
import type { ProviderAuthClient } from "../auth.js";
import { USAGE_HTTP_TIMEOUT_MS } from "../http.js";
import type { FetchJson } from "../http.js";
import { usageFailure } from "../providers.js";
import type {
  SupportedProvider,
  UsageFetchResult,
  UsageWindow,
  UsageWindowId,
} from "../providers.js";

export interface AdapterDeps {
  authClient: ProviderAuthClient;
  fetchJson: FetchJson;
  now?: () => number;
}

/**
 * GET a bearer-authenticated usage endpoint and map its checked payload. A 403
 * means the credential lacks this entitlement, so the provider is unavailable
 * rather than broken.
 */
export const fetchBearerUsage = async <S extends TSchema>(
  deps: AdapterDeps,
  provider: SupportedProvider,
  url: string,
  schema: S,
  map: (payload: Static<S>, nowMs: number) => UsageFetchResult,
): Promise<UsageFetchResult> => {
  const auth = await resolveAccessToken(deps.authClient, provider);

  if (!auth.ok) {
    return usageFailure(auth.message, auth.kind);
  }

  const response = await deps.fetchJson(url, schema, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${auth.value.accessToken}`,
    },
    timeoutMs: USAGE_HTTP_TIMEOUT_MS,
  });

  if (response.ok) {
    return map(response.json, (deps.now ?? Date.now)());
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

/**
 * Map a window length in seconds to a coarse bucket. 5h class accepts up to
 * 12h rolling windows; 7d class accepts multi-day through ~2 weeks.
 */
export const windowIdFromLimitSeconds = (seconds: number): UsageWindowId | undefined => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  if (seconds <= 12 * 3600) {
    return "5h";
  }

  if (seconds <= 14 * 86_400) {
    return "7d";
  }

  return "month";
};
