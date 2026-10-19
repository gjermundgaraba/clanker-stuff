import type { SupportedProvider, UsageFetchResult, UsageSnapshot } from "./providers.js";
import { usageFailure } from "./providers.js";

const CACHE_TTL_MS = 60_000;

export class UsageCache {
  private readonly success = new Map<SupportedProvider, UsageSnapshot>();
  private readonly inflight = new Map<SupportedProvider, Promise<UsageFetchResult>>();

  constructor(private readonly now: () => number) {}

  getLastSuccess(provider: SupportedProvider): UsageSnapshot | undefined {
    return this.success.get(provider);
  }

  async getOrFetch(
    provider: SupportedProvider,
    force: boolean,
    fetcher: () => Promise<UsageFetchResult>,
  ): Promise<UsageFetchResult> {
    const last = this.success.get(provider);

    if (!force && last !== undefined && this.now() - last.fetchedAt < CACHE_TTL_MS) {
      return { ok: true, snapshot: last };
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
    fetcher: () => Promise<UsageFetchResult>,
  ): Promise<UsageFetchResult> {
    try {
      const result = await fetcher();

      if (result.ok) {
        this.success.set(provider, result.snapshot);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unexpected fetch error";

      return usageFailure(message);
    }
  }
}
