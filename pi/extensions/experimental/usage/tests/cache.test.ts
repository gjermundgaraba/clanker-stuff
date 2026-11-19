import { describe, expect, it } from "vite-plus/test";

import { UsageCache } from "../cache.js";
import type { UsageSnapshot } from "../providers.js";

const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  fetchedAt: 1000,
  provider: "anthropic",
  quotaWindows: [
    { label: "5h", remainingPercent: 68 },
    { label: "week", remainingPercent: 66 },
  ],
  ...overrides,
});

describe("usage cache", () => {
  it("returns fresh success within TTL and fetches again after", async () => {
    let now = 10_000;
    let fetches = 0;
    const cache = new UsageCache(() => now);

    const fetcher = async () => {
      fetches += 1;

      return { ok: true as const, snapshot: snapshot({ fetchedAt: now }) };
    };

    await cache.getOrFetch("anthropic", "scope", false, fetcher);
    now = 69_999;
    await cache.getOrFetch("anthropic", "scope", false, fetcher);
    expect(fetches).toBe(1);
    now = 70_000;
    await cache.getOrFetch("anthropic", "scope", false, fetcher);
    expect(fetches).toBe(2);
    expect(cache.getLastSuccess("anthropic", "scope")?.fetchedAt).toBe(70_000);
  });

  it("shares a single in-flight fetch across callers", async () => {
    const cache = new UsageCache(() => 5000);
    let starts = 0;

    const { promise: gate, resolve: release } =
      Promise.withResolvers<UsageSnapshot>();

    const fetcher = async () => {
      starts += 1;

      return { ok: true as const, snapshot: await gate };
    };

    const first = cache.getOrFetch("xai", "scope", true, fetcher);
    const second = cache.getOrFetch("xai", "scope", true, fetcher);
    expect(starts).toBe(1);
    release(
      snapshot({
        fetchedAt: 5000,
        provider: "xai",
        quotaWindows: [{ label: "month", remainingPercent: 80 }],
      })
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a.result.ok && b.result.ok).toBeTruthy();
    expect(starts).toBe(1);
  });

  it("retains the last success after failure", async () => {
    let now = 1000;
    const cache = new UsageCache(() => now);
    await cache.getOrFetch("anthropic", "scope", true, async () => ({
      ok: true,
      snapshot: snapshot({ fetchedAt: 1000 }),
    }));
    now = 2000;

    const result = await cache.getOrFetch(
      "anthropic",
      "scope",
      true,
      async () => ({
        error: { kind: "failure" as const, message: "boom" },
        ok: false as const,
      })
    );

    expect(result.result.ok).toBeFalsy();
    expect(result.snapshot?.fetchedAt).toBe(1000);
    expect(cache.getLastSuccess("anthropic", "scope")?.fetchedAt).toBe(1000);
    expect(
      cache.getLastSuccess("anthropic", "scope")?.quotaWindows[0]
        ?.remainingPercent
    ).toBe(68);
  });

  it("replaces the last success after a forced successful refresh", async () => {
    const cache = new UsageCache(() => 3000);
    await cache.getOrFetch("anthropic", "scope", true, async () => ({
      ok: true,
      snapshot: snapshot({ fetchedAt: 1000 }),
    }));

    const result = await cache.getOrFetch(
      "anthropic",
      "scope",
      true,
      async () => ({
        ok: true as const,
        snapshot: snapshot({
          fetchedAt: 3000,
          quotaWindows: [{ label: "5h", remainingPercent: 10 }],
        }),
      })
    );

    expect(result.result.ok).toBeTruthy();
    expect(
      cache.getLastSuccess("anthropic", "scope")?.quotaWindows[0]
        ?.remainingPercent
    ).toBe(10);
  });

  it("discards a provider's usage when its scope changes, even from a late fetch", async () => {
    const cache = new UsageCache(() => 1000);
    const late = Promise.withResolvers<undefined>();

    await cache.getOrFetch("anthropic", "first", false, async () => ({
      ok: true,
      snapshot: snapshot({ fetchedAt: 900 }),
    }));

    const lateRead = cache.getOrFetch("anthropic", "first", true, async () => {
      await late.promise;

      return { ok: true, snapshot: snapshot({ fetchedAt: 950 }) };
    });

    const failed = await cache.getOrFetch(
      "anthropic",
      "second",
      false,
      async () => ({
        error: { kind: "failure", message: "boom" },
        ok: false,
      })
    );

    expect(failed.snapshot).toBeUndefined();

    late.resolve(undefined);
    await expect(lateRead).resolves.toMatchObject({
      snapshot: { fetchedAt: 950 },
    });
    expect(cache.getLastSuccess("anthropic", "first")).toBeUndefined();
    expect(cache.getLastSuccess("anthropic", "second")).toBeUndefined();

    let fetches = 0;
    await cache.getOrFetch("anthropic", "first", false, async () => {
      fetches += 1;

      return { ok: true, snapshot: snapshot({ fetchedAt: 1000 }) };
    });
    expect(fetches).toBe(1);
  });
});
