import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
} from "./providers.js";
import { usageFailure } from "./providers.js";

const CACHE_TTL_MS = 60_000;

export interface UsageReading {
  result: UsageFetchResult;
  snapshot?: UsageSnapshot;
}

interface ScopedUsage {
  scope: string;
  snapshot?: UsageSnapshot;
  inflight?: Promise<UsageFetchResult>;
}

const runFetch = async (
  fetcher: () => Promise<UsageFetchResult>
): Promise<UsageFetchResult> => {
  try {
    return await fetcher();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unexpected fetch error";

    return usageFailure(message);
  }
};

export class UsageCache {
  private readonly slots = new Map<SupportedProvider, ScopedUsage>();

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  getLastSuccess(
    provider: SupportedProvider,
    scope: string
  ): UsageSnapshot | undefined {
    const slot = this.slots.get(provider);

    return slot?.scope === scope ? slot.snapshot : undefined;
  }

  record(
    provider: SupportedProvider,
    scope: string,
    snapshot: UsageSnapshot
  ): void {
    const slot = this.slots.get(provider);

    if (slot?.scope === scope) {
      slot.snapshot = snapshot;
    } else {
      this.slots.set(provider, { scope, snapshot });
    }
  }

  async getOrFetch(
    provider: SupportedProvider,
    scope: string,
    force: boolean,
    fetcher: () => Promise<UsageFetchResult>
  ): Promise<UsageReading> {
    let slot = this.slots.get(provider);

    if (slot?.scope !== scope) {
      slot = { scope };
      this.slots.set(provider, slot);
    }

    const last = slot.snapshot;

    if (
      !force &&
      last !== undefined &&
      this.now() - last.fetchedAt < CACHE_TTL_MS
    ) {
      return { result: { ok: true, snapshot: last }, snapshot: last };
    }

    slot.inflight ??= runFetch(fetcher);
    const { inflight } = slot;
    const result = await inflight;

    if (slot.inflight === inflight) {
      delete slot.inflight;
    }

    if (result.ok) {
      slot.snapshot = result.snapshot;
    }

    const snapshot = result.ok ? result.snapshot : slot.snapshot;

    return { result, ...(snapshot === undefined ? {} : { snapshot }) };
  }
}
