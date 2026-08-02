import type {
  SupportedProvider,
  UsageFetchResult,
  UsageSnapshot,
} from "./types.js";
import { usageFailure } from "./types.js";

const CACHE_TTL_MS = 60_000;

export interface UsageCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export class UsageCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly success = new Map<SupportedProvider, UsageSnapshot>();
  private readonly inflight = new Map<
    SupportedProvider,
    Promise<UsageFetchResult>
  >();

  constructor(options: UsageCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  private getFresh(provider: SupportedProvider): UsageSnapshot | undefined {
    const snapshot = this.success.get(provider);
    if (snapshot === undefined) {
      return undefined;
    }
    if (this.now() - snapshot.fetchedAt >= this.ttlMs) {
      return undefined;
    }
    return snapshot;
  }

  getLastSuccess(provider: SupportedProvider): UsageSnapshot | undefined {
    return this.success.get(provider);
  }

  async getOrFetch(
    provider: SupportedProvider,
    force: boolean,
    fetcher: () => Promise<UsageFetchResult>
  ): Promise<UsageFetchResult> {
    if (!force) {
      const fresh = this.getFresh(provider);
      if (fresh !== undefined) {
        return { ok: true, snapshot: fresh };
      }
    }

    const existing = this.inflight.get(provider);
    if (existing !== undefined) {
      return await existing;
    }

    const promise = this.runFetch(provider, fetcher);
    this.inflight.set(provider, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(provider);
    }
  }

  private async runFetch(
    provider: SupportedProvider,
    fetcher: () => Promise<UsageFetchResult>
  ): Promise<UsageFetchResult> {
    try {
      const result = await fetcher();
      if (result.ok) {
        this.success.set(provider, result.snapshot);
        return result;
      }
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unexpected fetch error";
      return usageFailure(message);
    }
  }
}
