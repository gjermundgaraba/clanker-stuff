import type { UsageFetchResult, UsageSnapshot } from "./providers.js";
import { usageFailure } from "./providers.js";

const CACHE_TTL_MS = 60_000;
const MAX_SAVED_SCOPES = 32;

export class UsageCache {
  private readonly success = new Map<string, UsageSnapshot>();
  private readonly inflight = new Map<string, Promise<UsageFetchResult>>();

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  getLastSuccess(scope: string): UsageSnapshot | undefined {
    return this.success.get(scope);
  }

  async getOrFetch(
    scope: string,
    force: boolean,
    fetcher: () => Promise<UsageFetchResult>
  ): Promise<UsageFetchResult> {
    const last = this.success.get(scope);

    if (
      !force &&
      last !== undefined &&
      this.now() - last.fetchedAt < CACHE_TTL_MS
    ) {
      return { ok: true, snapshot: last };
    }

    const existing = this.inflight.get(scope);

    if (existing !== undefined) {
      return await existing;
    }

    const promise = this.runFetch(scope, fetcher);
    this.inflight.set(scope, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(scope);
    }
  }

  private async runFetch(
    scope: string,
    fetcher: () => Promise<UsageFetchResult>
  ): Promise<UsageFetchResult> {
    try {
      const result = await fetcher();

      if (result.ok) {
        this.success.delete(scope);
        this.success.set(scope, result.snapshot);

        if (this.success.size > MAX_SAVED_SCOPES) {
          const oldest = this.success.keys().next().value;

          if (oldest !== undefined) {
            this.success.delete(oldest);
          }
        }
      }

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unexpected fetch error";

      return usageFailure(message);
    }
  }
}
